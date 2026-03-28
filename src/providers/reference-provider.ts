import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { isLinePositionInComment, computeCommentRanges, isOffsetInComment } from './comment-utils';

/**
 * Find All References for ref('model'), source('src', 'table'), and column
 * names within the current SQL model.  For ref/source uses the manifest
 * dependency graph — no workspace-wide scan.
 */
export class DbtReferenceProvider implements vscode.ReferenceProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

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

		// Column references within the same file
		if (this.columnResolver) {
			return this._findColumnReferences(document, position, line, token);
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

		// Find the source's uniqueId
		const sourceUid = this._findSourceUid(sourceName, tableName, index);
		if (!sourceUid) return [];

		const locations: vscode.Location[] = [];
		const pattern = new RegExp(
			`source\\(\\s*['"]${this._escapeRegex(sourceName)}['"]\\s*,\\s*['"]${this._escapeRegex(tableName)}['"]\\s*\\)`,
			'g',
		);

		const childIds = index.childMap.get(sourceUid) ?? [];
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

	/** Find the source uniqueId by source name + table name. */
	private _findSourceUid(
		sourceName: string,
		tableName: string,
		index: import('../indexing/manifest-indexer').ManifestIndex,
	): string | undefined {
		for (const [uid, src] of index.sources) {
			if (src.sourceName === sourceName && src.name === tableName) return uid;
		}
		return undefined;
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

	private async _findColumnReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		line: string,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[]> {
		// Skip Jinja blocks
		const prefix = line.substring(0, position.character);
		if (/\{\{[^}]*$/.test(prefix) || /\{%[^%]*$/.test(prefix)) return [];

		const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
		if (!wordRange) return [];
		const word = document.getText(wordRange);
		if (REFERENCE_SQL_KEYWORDS.has(word.toUpperCase())) return [];

		// Get scope aliases to verify this is actually a column
		const aliases = await this.columnResolver!.getScopeAliases(document, token);
		if (token.isCancellationRequested) return [];

		// Detect alias.column
		const nearby = line.substring(Math.max(0, wordRange.start.character - 40), wordRange.end.character + 40);
		const dotMatch = /(\w+)\.(\w+)/.exec(nearby);
		let columnName: string | undefined;

		if (dotMatch) {
			const dotOffset = nearby.indexOf(dotMatch[0]);
			const absStart = Math.max(0, wordRange.start.character - 40) + dotOffset;
			const colStart = absStart + dotMatch[1].length + 1;
			const colEnd = colStart + dotMatch[2].length;
			if (position.character >= colStart && position.character <= colEnd) {
				const alias = dotMatch[1];
				const cols = aliases[alias] ?? aliases[alias.toLowerCase()];
				if (cols && cols.some(c => c.toLowerCase() === dotMatch[2].toLowerCase())) {
					columnName = dotMatch[2];
				}
			}
		}

		// Try bare column name
		if (!columnName) {
			for (const cols of Object.values(aliases)) {
				if (cols.some(c => c.toLowerCase() === word.toLowerCase())) {
					columnName = word;
					break;
				}
			}
		}

		if (!columnName) return [];

		// Find all occurrences of the column name in this file
		const text = document.getText();
		const commentRanges = computeCommentRanges(text);
		const pattern = new RegExp(`\\b${this._escapeRegex(columnName)}\\b`, 'gi');
		const locations: vscode.Location[] = [];
		let m;
		while ((m = pattern.exec(text)) !== null) {
			if (token.isCancellationRequested) break;
			if (isOffsetInComment(m.index, commentRanges)) continue;
			const pos = document.positionAt(m.index);
			const endPos = document.positionAt(m.index + m[0].length);
			// Skip occurrences inside Jinja blocks
			const matchLine = document.lineAt(pos.line).text;
			const beforeMatch = matchLine.substring(0, pos.character);
			if (/\{\{[^}]*$/.test(beforeMatch) || /\{%[^%]*$/.test(beforeMatch)) continue;
			// Skip SQL keywords that happen to match
			if (REFERENCE_SQL_KEYWORDS.has(m[0].toUpperCase())) continue;
			locations.push(new vscode.Location(document.uri, new vscode.Range(pos, endPos)));
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} column references for '${columnName}'`);
		return locations;
	}
}

const REFERENCE_SQL_KEYWORDS = new Set([
	'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'ON', 'AS',
	'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
	'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
	'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BETWEEN',
	'LIKE', 'IS', 'NULL', 'TRUE', 'FALSE', 'DISTINCT', 'ALL',
]);
