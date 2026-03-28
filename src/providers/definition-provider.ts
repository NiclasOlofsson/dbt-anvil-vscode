import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import type { CteInfo, DocumentModel, RefInfo, SourceInfo, TableRefToken } from '../services/parse-service';
import { isLinePositionInComment } from './comment-utils';

/**
 * Resolve what a SQL alias refers to in a DocumentModel.
 * Pure function — no VS Code dependency — exported for testing.
 *
 * When `atLine` is provided the lookup is scoped to the enclosing CTE body
 * first, so inner aliases shadow outer ones correctly.
 */
export function resolveAlias(
	model: DocumentModel,
	alias: string,
	atLine?: number,
): { kind: 'cte'; cte: CteInfo } | { kind: 'ref'; ref: RefInfo } | { kind: 'source'; source: SourceInfo } | undefined {
	const lc = alias.toLowerCase();

	if (atLine !== undefined) {
		const enclosingCte = model.ctes.find(c => atLine > c.line && atLine <= c.endLine);
		if (enclosingCte) {
			const scopedRef = model.refs.find(
				r => r.line >= enclosingCte.line && r.line <= enclosingCte.endLine
					&& (r.alias ?? r.model).toLowerCase() === lc,
			);
			if (scopedRef) return { kind: 'ref', ref: scopedRef };

			const scopedSrc = model.sources.find(
				s => s.line >= enclosingCte.line && s.line <= enclosingCte.endLine
					&& (s.alias ?? s.tableName).toLowerCase() === lc,
			);
			if (scopedSrc) return { kind: 'source', source: scopedSrc };

			const scopedCteTok = model.tokens.find(
				t => t.type === 'table_ref' && t.line >= enclosingCte.line && t.line <= enclosingCte.endLine
					&& t.alias?.toLowerCase() === lc
					&& model.ctes.some(c => c.name.toLowerCase() === t.name.toLowerCase()),
			);
			if (scopedCteTok) {
				const cte = model.ctes.find(c => c.name.toLowerCase() === scopedCteTok.name.toLowerCase())!;
				return { kind: 'cte', cte };
			}
		}
	}

	const directCte = model.ctes.find(c =>
		c.name.toLowerCase() === lc || c.alias?.toLowerCase() === lc,
	);
	if (directCte) return { kind: 'cte', cte: directCte };

	const cteTok = model.tokens.find(t =>
		t.type === 'table_ref' && t.alias?.toLowerCase() === lc
		&& model.ctes.some(c => c.name.toLowerCase() === t.name.toLowerCase()),
	);
	if (cteTok) {
		const cte = model.ctes.find(c => c.name.toLowerCase() === cteTok.name.toLowerCase())!;
		return { kind: 'cte', cte };
	}

	const ref = model.refs.find(r => (r.alias ?? r.model).toLowerCase() === lc);
	if (ref) return { kind: 'ref', ref };

	const src = model.sources.find(s => (s.alias ?? s.tableName).toLowerCase() === lc);
	if (src) return { kind: 'source', source: src };

	return undefined;
}

/**
 * Go-to-definition for ref('model_name'), source('source', 'table'),
 * CTE names in FROM/JOIN, and column names (alias.column → CTE definition).
 */
export class DbtDefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Definition | undefined> {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.definition', true)) return undefined;
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return undefined;

		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService.getDocumentModel(document, dialect);
		if (token.isCancellationRequested || !model) return undefined;

		// Check refs: full {{ ref(...) }} jinja span is clickable
		const ref = model.refs.find(r =>
			r.line === position.line &&
			r.jinjaCol !== undefined && r.jinjaEndCol !== undefined &&
			position.character >= r.jinjaCol && position.character < r.jinjaEndCol,
		);
		if (ref) {
			const def = this._resolveRef(ref.model);
			this.logger.trace(`Definition: ref('${ref.model}') → ${def ? 'resolved' : 'not found'}`);
			return def;
		}

		// Check sources: only the table name identifier is clickable
		const src = model.sources.find(s =>
			s.line === position.line &&
			s.tableNameCol !== undefined && s.tableNameEndCol !== undefined &&
			position.character >= s.tableNameCol && position.character < s.tableNameEndCol,
		);
		if (src) {
			const def = this._resolveSource(src.sourceName, src.tableName);
			this.logger.trace(`Definition: source('${src.sourceName}', '${src.tableName}') → ${def ? 'resolved' : 'not found'}`);
			return def;
		}

		// Token-based resolution: CTE navigation, column definitions, qualifiers
		return this._resolveToken(document, position, token, model);
	}

	private _resolveRef(modelName: string): vscode.Definition | undefined {
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return undefined;

		// Multiple packages → return all locations so the editor shows a picker
		if (models.length > 1) {
			return models
				.filter(m => m.path)
				.map(m => new vscode.Location(vscode.Uri.file(m.path), new vscode.Position(0, 0)));
		}

		const model = models[0];
		if (!model.path) return undefined;
		try {
			return new vscode.Location(vscode.Uri.file(model.path), new vscode.Position(0, 0));
		} catch {
			return undefined;
		}
	}

	private _resolveSource(sourceName: string, tableName: string): vscode.Location | undefined {
		const found = this.indexer.findSourceByKey(sourceName, tableName);
		if (!found) return undefined;

		// Find the schema.yml that declares this source via its original_file_path
		const raw = this.indexer.getRawNode(found.uid);
		if (raw && raw.original_file_path) {
			const filePath = path.join(this.loader.projectDir, raw.original_file_path);
			try {
				return new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0));
			} catch {
				// fall through
			}
		}

		return undefined;
	}

	// ---- Token-based definition (AST position resolution) ----

	private async _resolveToken(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		model: DocumentModel,
	): Promise<vscode.Definition | undefined> {
		if (token.isCancellationRequested) return undefined;

		const resolved = ParseService.resolveAtPosition(model, position.line, position.character);
		if (!resolved) {
			this.logger.trace(`Definition: no token at ${position.line}:${position.character} (${model.tokens.length} tokens in model)`);
			return undefined;
		}
		this.logger.trace(`Definition: token at ${position.line}:${position.character} → kind='${resolved.kind}' name='${resolved.token.name}'`);

		switch (resolved.kind) {
			case 'table_ref': {
				const name = resolved.token.name;
				return this._jumpToCte(document, model, name)
					?? this._resolveRef(name);
			}
			case 'table_alias':
			case 'column_def': {
				return undefined;
			}
			case 'table_qualifier': {
				const alias = resolved.token.table!;
				const refTok = model.tokens.find((t): t is TableRefToken =>
					t.type === 'table_ref' && t.alias?.toLowerCase() === alias.toLowerCase(),
				);
				if (refTok && refTok.aliasLine !== undefined && refTok.aliasCol !== undefined) {
					return new vscode.Location(document.uri, new vscode.Position(refTok.aliasLine, refTok.aliasCol));
				}
				return this._jumpToCte(document, model, alias);
			}
			case 'column': {
				const colToken = resolved.token;
				if (colToken.table) {
					return this._jumpToColumn(document, model, colToken.table, colToken.name, colToken.line);
				}
				this.logger.trace(`Definition: bare column '${colToken.name}' (no table qualifier) → undefined`);
				return undefined;
			}
		}
	}

	// ---- Navigate to alias.column ----

	private async _jumpToColumn(
		document: vscode.TextDocument,
		model: DocumentModel,
		alias: string,
		column: string,
		atLine?: number,
	): Promise<vscode.Definition | undefined> {
		const target = resolveAlias(model, alias, atLine);
		if (!target) {
			this.logger.trace(`Definition: qualifier '${alias}' not found in CTEs, refs, or sources → undefined`);
			return undefined;
		}
		switch (target.kind) {
			case 'cte': return this._jumpToCteColumn(document, model, target.cte, column);
			case 'ref': return this._jumpToModelColumn(target.ref.model, column);
			case 'source': return this._jumpToSourceColumn(target.source, column);
		}
	}

	private async _jumpToCteColumn(
		document: vscode.TextDocument,
		_model: DocumentModel,
		cte: CteInfo,
		column: string,
	): Promise<vscode.Location | undefined> {
		const col = cte.columns.find(c => c.name.toLowerCase() === column.toLowerCase());
		if (col) {
			this.logger.trace(`Definition: '${column}' in CTE '${cte.name}' → line ${col.line + 1}`);
			return new vscode.Location(document.uri, new vscode.Position(col.line, 0));
		}

		// Column not explicit — SELECT * means the column comes through unchanged; navigate to the *
		const starCol = cte.columns.find(c => c.name === '*');
		if (starCol) {
			this.logger.trace(`Definition: '${column}' from SELECT * in CTE '${cte.name}' → * at line ${starCol.line + 1}`);
			return new vscode.Location(document.uri, new vscode.Position(starCol.line, 0));
		}

		this.logger.trace(`Definition: '${column}' not resolved in CTE '${cte.name}' → CTE line ${cte.line + 1}`);
		return new vscode.Location(document.uri, new vscode.Position(cte.line, 0));
	}

	private async _jumpToModelColumn(modelName: string, column: string): Promise<vscode.Definition | undefined> {
		const modelLoc = this._resolveRef(modelName);
		if (!modelLoc) return undefined;

		const uri = Array.isArray(modelLoc) ? (modelLoc[0] as vscode.Location).uri : (modelLoc as vscode.Location).uri;

		try {
			const targetDoc = await vscode.workspace.openTextDocument(uri);
			const dialect = this.indexer.index?.adapterType ?? 'ansi';
			const targetModel = await this.parseService!.getDocumentModel(targetDoc, dialect);
			if (targetModel) {
				const col = targetModel.finalColumns.find(c => c.name.toLowerCase() === column.toLowerCase());
				if (col) {
					this.logger.trace(`Definition: '${column}' in ref '${modelName}' → line ${col.line + 1}`);
					return new vscode.Location(uri, new vscode.Position(col.line, 0));
				}
			}
		} catch {
			// parse failed — fall through to file-level location
		}

		this.logger.trace(`Definition: '${column}' in ref '${modelName}' → model file (column not found in parsed output)`);
		return modelLoc;
	}

	private _jumpToSourceColumn(source: SourceInfo, column: string): vscode.Definition | undefined {
		this.logger.trace(`Definition: '${column}' in source '${source.sourceName}.${source.tableName}' → schema file`);
		return this._resolveSource(source.sourceName, source.tableName);
	}

	// ---- Jump to CTE / ref / source by alias name ----

	private _jumpToCte(
		document: vscode.TextDocument,
		model: DocumentModel,
		alias: string,
		column?: string,
	): vscode.Definition | undefined {
		const lc = alias.toLowerCase();

		const cte = model.ctes.find(c => c.name.toLowerCase() === lc || c.alias?.toLowerCase() === lc);
		if (cte) {
			if (column) {
				const col = cte.columns.find(c => c.name.toLowerCase() === column.toLowerCase());
				if (col) {
					this.logger.trace(`Definition: column '${column}' in CTE '${alias}' → line ${col.line + 1}`);
					return new vscode.Location(document.uri, new vscode.Position(col.line, 0));
				}
			}
			this.logger.trace(`Definition: CTE '${alias}' → line ${cte.line + 1}`);
			return new vscode.Location(document.uri, new vscode.Position(cte.line, 0));
		}

		const ref = model.refs.find(r => r.alias?.toLowerCase() === lc);
		if (ref) {
			this.logger.trace(`Definition: alias '${alias}' → ref('${ref.model}')`);
			return this._resolveRef(ref.model) as vscode.Location | undefined;
		}

		const source = model.sources.find(s => s.alias?.toLowerCase() === lc);
		if (source) {
			this.logger.trace(`Definition: alias '${alias}' → source('${source.sourceName}','${source.tableName}')`);
			return this._resolveSource(source.sourceName, source.tableName);
		}

		return undefined;
	}

}

