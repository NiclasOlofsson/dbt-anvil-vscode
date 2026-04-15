import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import { isLinePositionInComment, computeCommentRanges, isOffsetInComment } from '../common/comment-utils';
import { SQL_KEYWORDS } from './sql-keywords';

/**
 * Find All References for ref('model'), source('src', 'table'), and column
 * names within the current SQL model.  For ref/source uses the manifest
 * dependency graph — no workspace-wide scan.
 */
export class DbtReferenceProvider implements vscode.ReferenceProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	async provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.ReferenceContext,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[]> {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.references', true)) return [];
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return [];

		if (this.parseService) {
			const model = await this.parseService.getDocumentModel(document);
			if (!token.isCancellationRequested && model) {
				// Check refs: full {{ ref(...) }} jinja span is clickable
				const ref = model.refs.find(r =>
					r.line === position.line &&
					r.jinjaCol !== undefined && r.jinjaEndCol !== undefined &&
					position.character >= r.jinjaCol && position.character < r.jinjaEndCol,
				);
				if (ref) return this._findRefUsages(ref.model, token);

				// Check sources: only the table name identifier span
				const src = model.sources.find(s =>
					s.line === position.line &&
					s.tableNameCol !== undefined && s.tableNameEndCol !== undefined &&
					position.character >= s.tableNameCol && position.character < s.tableNameEndCol,
				);
				if (src) return this._findSourceUsages(src.sourceName, src.tableName, token);

				// Token-based dispatch using resolved position
				const resolved = ParseService.resolveAtPosition(model, position.line, position.character);

				if (resolved?.kind === 'column' || resolved?.kind === 'column_def') {
					return this._findColumnReferences(document, resolved.token.name, token);
				}

				if (resolved?.kind === 'table_ref') {
					// CTE name → in-file references
					const cte = model.ctes.find(c => c.name === resolved.token.name);
					if (cte) return this._findCteReferences(document, resolved.token.name, model, cte);

					// table_ref that matches a ref() → cross-file references
					const matchingRef = model.refs.find(r => r.model === resolved.token.name);
					if (matchingRef) return this._findRefUsages(resolved.token.name, token);
				}

				if (resolved?.kind === 'table_alias') {
					return this._findAliasReferences(document, resolved.token.alias!, model);
				}

				if (resolved?.kind === 'table_qualifier') {
					// Qualifier `o` in `o.col` — find the alias it resolves to
					const alias = resolved.token.resolvedTableRef?.alias ?? resolved.token.table;
					if (alias) return this._findAliasReferences(document, alias, model);
				}

				return [];
			}
		}

		// Fallback when parseService is not available
		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._findRefUsages(match[1], token);
			}
		}

		const sourceRe = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceRe.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._findSourceUsages(match[1], match[2], token);
			}
		}

		return [];
	}

	private async _findRefUsages(modelName: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const index = this.indexer.index;
		if (!index) return [];

		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return [];

		const locations: vscode.Location[] = [];
		const pattern = new RegExp(`ref\\(\\s*['"]${this._escapeRegex(modelName)}['"]\\s*\\)`, 'g');

		for (const model of models) {
			// Include the model definition itself
			if (model.path) {
				locations.push(new vscode.Location(vscode.Uri.file(model.path), new vscode.Position(0, 0)));
			}

			// Use childMap to find downstream dependents
			const childIds = index.childMap.get(model.uniqueId) ?? [];
			const filePaths = this._resolveFilePaths(childIds, index);

			for (const filePath of filePaths) {
				if (token.isCancellationRequested) break;
				const found = await this._findPatternInFile(vscode.Uri.file(filePath), pattern);
				locations.push(...found);
			}
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for ref('${modelName}')`);
		return locations;
	}

	private async _findSourceUsages(sourceName: string, tableName: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const index = this.indexer.index;
		if (!index) return [];

		const found = this.indexer.findSourceByKey(sourceName, tableName);
		if (!found) return [];

		const locations: vscode.Location[] = [];
		const pattern = new RegExp(
			`source\\(\\s*['"]${this._escapeRegex(sourceName)}['"]\\s*,\\s*['"]${this._escapeRegex(tableName)}['"]\\s*\\)`,
			'g',
		);

		const childIds = index.childMap.get(found.uid) ?? [];
		const filePaths = this._resolveFilePaths(childIds, index);

		for (const filePath of filePaths) {
			if (token.isCancellationRequested) break;
			const found = await this._findPatternInFile(vscode.Uri.file(filePath), pattern);
			locations.push(...found);
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for source('${sourceName}', '${tableName}')`);
		return locations;
	}

	/** Resolve a list of unique IDs to file paths via the models index. */
	private _resolveFilePaths(
		uniqueIds: string[],
		index: import('../../indexing/manifest-indexer').ManifestIndex,
	): string[] {
		const paths: string[] = [];
		const seen = new Set<string>();
		for (const uid of uniqueIds) {
			const model = index.models.get(uid);
			if (model?.path && !seen.has(model.path)) {
				seen.add(model.path);
				paths.push(model.path);
			}
		}
		return paths;
	}

	/** Open a single file and find all positions matching the pattern. */
	private async _findPatternInFile(fileUri: vscode.Uri, pattern: RegExp): Promise<vscode.Location[]> {
		const locations: vscode.Location[] = [];
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const text = doc.getText();
			const commentRanges = computeCommentRanges(text);
			let m;
			pattern.lastIndex = 0;
			while ((m = pattern.exec(text)) !== null) {
				if (isOffsetInComment(m.index, commentRanges)) continue;
				const pos = doc.positionAt(m.index);
				const endPos = doc.positionAt(m.index + m[0].length);
				locations.push(new vscode.Location(fileUri, new vscode.Range(pos, endPos)));
			}
		} catch {
			// File could not be opened — skip
		}
		return locations;
	}

	private _escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	// ---- CTE name references within the current file ----

	private _findCteReferences(
		document: vscode.TextDocument,
		cteName: string,
		model: import('../../services/parse-service').DocumentModel,
		cte: import('../../services/parse-service').CteInfo,
	): vscode.Location[] {
		const locations: vscode.Location[] = [];

		// CTE definition site (the name token after WITH / comma)
		const defCol = cte.col ?? 0;
		locations.push(new vscode.Location(
			document.uri,
			new vscode.Range(cte.line, defCol, cte.line, defCol + cteName.length),
		));

		// All table_ref tokens in this file with the same name (FROM/JOIN uses)
		for (const tok of model.tokens) {
			if (tok.type !== 'table_ref') continue;
			if (tok.name !== cteName) continue;
			// Skip the definition line itself to avoid double-counting
			if (tok.line === cte.line && tok.col === defCol) continue;
			locations.push(new vscode.Location(
				document.uri,
				new vscode.Range(tok.line, tok.col, tok.line, tok.endCol),
			));
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for CTE '${cteName}'`);
		return locations;
	}

	// ---- Table alias references within the current file ----

	private _findAliasReferences(
		document: vscode.TextDocument,
		alias: string,
		model: import('../../services/parse-service').DocumentModel,
	): vscode.Location[] {
		const locations: vscode.Location[] = [];

		// Find the table_ref token that declares this alias
		for (const tok of model.tokens) {
			if (tok.type !== 'table_ref' || tok.alias !== alias) continue;
			if (tok.aliasLine === undefined || tok.aliasCol === undefined || tok.aliasEndCol === undefined) continue;

			// Alias definition site
			locations.push(new vscode.Location(
				document.uri,
				new vscode.Range(tok.aliasLine, tok.aliasCol, tok.aliasLine, tok.aliasEndCol),
			));

			// All column_ref tokens where the qualifier matches this alias
			for (const colTok of model.tokens) {
				if (colTok.type !== 'column_ref') continue;
				if (colTok.table !== alias) continue;
				if (colTok.tableCol === undefined || colTok.tableEndCol === undefined) continue;
				locations.push(new vscode.Location(
					document.uri,
					new vscode.Range(colTok.tableLine ?? colTok.line, colTok.tableCol, colTok.tableLine ?? colTok.line, colTok.tableEndCol),
				));
			}

			break; // alias names are unique within a query
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for alias '${alias}'`);
		return locations;
	}

	// ---- Column references within the current file ----

	private _findColumnReferences(
		document: vscode.TextDocument,
		columnName: string,
		token: vscode.CancellationToken,
	): vscode.Location[] {
		const text = document.getText();
		const commentRanges = computeCommentRanges(text);
		const pattern = new RegExp(`\\b${this._escapeRegex(columnName)}\\b`, 'gi');
		const locations: vscode.Location[] = [];
		let m;
		while ((m = pattern.exec(text)) !== null) {
			if (token.isCancellationRequested) break;
			if (isOffsetInComment(m.index, commentRanges)) continue;
			if (SQL_KEYWORDS.has(m[0].toUpperCase())) continue;
			const pos = document.positionAt(m.index);
			// Skip occurrences inside Jinja blocks
			const matchLine = document.lineAt(pos.line).text;
			const beforeMatch = matchLine.substring(0, pos.character);
			if (/\{\{[^}]*$/.test(beforeMatch) || /\{%[^%]*$/.test(beforeMatch)) continue;
			locations.push(new vscode.Location(document.uri, new vscode.Range(pos, document.positionAt(m.index + m[0].length))));
		}
		this.logger.debug(`ReferenceProvider: found ${locations.length} column references for '${columnName}'`);
		return locations;
	}
}
