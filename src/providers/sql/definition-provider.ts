import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ManifestLoader } from '../../dbt/manifest-loader';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import type { CteInfo, DocumentModel, SourceInfo } from '../../services/parse-service';
import type { Sym } from '../../ftl/sqllens/api';
import { isLinePositionInComment } from '../common/comment-utils';
import { resolvePositionContext } from './position-context';

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
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.definition', true)) return undefined;
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return undefined;

		const model = await this.parseService.getDocumentModel(document);
		if (token.isCancellationRequested || !model) return undefined;

		const ctx = resolvePositionContext(model, line, position);

		if (ctx?.kind === 'ref') {
			const def = this._resolveRef(ctx.ref.model);
			this.logger.trace(`Definition: ref('${ctx.ref.model}') → ${def ? 'resolved' : 'not found'}`);
			return def;
		}
		if (ctx?.kind === 'source') {
			const def = this._resolveSource(ctx.source.sourceName, ctx.source.tableName);
			this.logger.trace(`Definition: source('${ctx.source.sourceName}', '${ctx.source.tableName}') → ${def ? 'resolved' : 'not found'}`);
			return def;
		}
		if (ctx?.kind === 'macro') {
			const def = this._resolveMacro(ctx.name);
			this.logger.trace(`Definition: macro '${ctx.name}' → ${def ? 'resolved' : 'not found'}`);
			return def;
		}
		if (ctx?.kind === 'sym') {
			return this._resolveToken(document, position, token, model, ctx.sym, ctx.partIndex);
		}

		return undefined;
	}

	private _resolveMacro(macroName: string): vscode.Location | undefined {
		const macro = this.indexer.findMacroByName(macroName);
		if (!macro) return undefined;
		if (!macro.filePath) return undefined;
		try {
			return new vscode.Location(vscode.Uri.file(macro.filePath), new vscode.Position(0, 0));
		} catch {
			return undefined;
		}
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

	// ---- Sym-based definition (AST position resolution) ----

	private async _resolveToken(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		model: DocumentModel,
		sym: Sym,
		partIndex: number | undefined,
	): Promise<vscode.Definition | undefined> {
		if (token.isCancellationRequested) return undefined;
		this.logger.trace(`Definition: sym at ${position.line}:${position.character} → kind='${sym.kind}' name='${sym.name}'`);

		// old 'table_alias' — a relation's own alias declaration has no separate definition.
		if (sym.kind === 'alias') return undefined;

		// old 'table_ref' — a FROM/JOIN table/CTE/subquery/lateral reference.
		if (sym.kind === 'table' || sym.kind === 'cte' || sym.kind === 'subquery' || sym.kind === 'lateral') {
			return this._jumpToCte(document, model, sym)
				?? this._resolveRef(sym.name);
		}

		if (sym.kind !== 'column') return undefined;

		// old 'column_def' — the alias/computed declaration site itself has no target.
		if (sym.modifiers.includes('declaration')) return undefined;

		const resolved = sym.source;
		const isQualifierPart = sym.partSpans !== undefined
			&& partIndex !== undefined
			&& partIndex < sym.partSpans.length - 1;

		if (isQualifierPart) {
			// old 'table_qualifier'
			const alias = resolved?.alias;
			if (alias) {
				return new vscode.Location(document.uri, new vscode.Position(alias.span.line - 1, alias.span.column));
			}
			const qualifierText = sym.name.split('.').slice(0, -1).join('.');
			return this._jumpToCte(document, model, qualifierText);
		}

		// old 'column'
		const bareName = sym.name.split('.').pop()!;
		if (resolved) {
			const ref = model.refs.find(r => r.model.toLowerCase() === resolved.name.toLowerCase());
			if (ref) return this._jumpToModelColumn(ref.model, bareName);
			const src = model.sources.find(s => s.tableName.toLowerCase() === resolved.name.toLowerCase());
			if (src) return this._jumpToSourceColumn(src, bareName);
			const cte = ParseService.cteForRef(resolved, model);
			if (cte) return this._jumpToCteColumn(document, model, cte, bareName);
		}
		this.logger.trace(`Definition: column '${sym.name}' has no resolved source → undefined`);
		return undefined;
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
			return new vscode.Location(document.uri, new vscode.Position(col.line, col.col ?? 0));
		}

		// Column not explicit — SELECT * means the column comes through unchanged; navigate to the *
		const starCol = cte.columns.find(c => c.name === '*');
		if (starCol) {
			this.logger.trace(`Definition: '${column}' from SELECT * in CTE '${cte.name}' → * at line ${starCol.line + 1}`);
			return new vscode.Location(document.uri, new vscode.Position(starCol.line, starCol.col ?? 0));
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
			const targetModel = await this.parseService!.getDocumentModel(targetDoc);
			if (targetModel) {
				const col = targetModel.finalColumns.find(c => c.name.toLowerCase() === column.toLowerCase());
				if (col) {
					this.logger.trace(`Definition: '${column}' in ref '${modelName}' → line ${col.line + 1}`);
					return new vscode.Location(uri, new vscode.Position(col.line, col.col ?? 0));
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
		aliasOrToken: string | Sym,
		column?: string,
	): vscode.Definition | undefined {
		const alias = typeof aliasOrToken === 'string' ? aliasOrToken : aliasOrToken.name;
		const lc = alias.toLowerCase();

		const cte = typeof aliasOrToken !== 'string'
			? ParseService.cteForRef(aliasOrToken, model)
			: model.ctes.find(c => c.name.toLowerCase() === lc || c.alias?.toLowerCase() === lc);
		if (cte) {
			if (column) {
				const col = cte.columns.find(c => c.name.toLowerCase() === column.toLowerCase());
				if (col) {
					this.logger.trace(`Definition: column '${column}' in CTE '${alias}' → line ${col.line + 1}`);
					return new vscode.Location(document.uri, new vscode.Position(col.line, col.col ?? 0));
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

