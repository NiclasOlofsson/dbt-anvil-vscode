import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import { isLinePositionInComment, computeCommentRanges, isOffsetInComment } from './comment-utils';
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
			const dialect = this.indexer.index?.adapterType ?? 'ansi';
			const model = await this.parseService.getDocumentModel(document, dialect);
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

				// Token-based: column references within this file
				const resolved = ParseService.resolveAtPosition(model, position.line, position.character);
				if (resolved?.kind === 'column' || resolved?.kind === 'column_def') {
					return this._findColumnReferences(document, resolved.token.name, token);
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
		index: import('../indexing/manifest-indexer').ManifestIndex,
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
