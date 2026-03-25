import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ILogger } from '../types/logger';
import type { ColumnResolver } from './column-resolver';
import { isLinePositionInComment } from './comment-utils';

/**
 * Go-to-definition for ref('model_name'), source('source', 'table'),
 * and column names (alias.column → CTE definition).
 */
export class DbtDefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
		private readonly columnResolver?: ColumnResolver,
	) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Definition | undefined> {
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return undefined;

		// Match ref('model_name') or ref("model_name")
		const refMatch = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				const def = this._resolveRef(match[1]);
				this.logger.debug(`Definition: ref('${match[1]}') → ${def ? 'resolved' : 'not found'}`);
				return def;
			}
		}

		// Match source('source_name', 'table_name')
		const sourceMatch = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				const def = this._resolveSource(match[1], match[2]);
				this.logger.debug(`Definition: source('${match[1]}', '${match[2]}') → ${def ? 'resolved' : 'not found'}`);
				return def;
			}
		}

		// Column definition: alias.column → jump to CTE that defines the alias
		if (this.columnResolver) {
			return this._resolveColumn(document, position, line, token);
		}

		return undefined;
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
		const index = this.indexer.index;
		if (!index) return undefined;
		const key = `${sourceName}.${tableName}`;
		const uids = index.nodesByName.get(key);
		if (!uids || uids.length === 0) return undefined;

		const source = index.sources.get(uids[0]);
		if (!source) return undefined;

		// Find the schema.yml that declares this source via its original_file_path
		const raw = this.indexer.getRawNode(uids[0]);
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

	// ---- Column go-to-definition ----

	private async _resolveColumn(
		document: vscode.TextDocument,
		position: vscode.Position,
		line: string,
		token: vscode.CancellationToken,
	): Promise<vscode.Definition | undefined> {
		// Skip Jinja blocks
		const prefix = line.substring(0, position.character);
		if (/\{\{[^}]*$/.test(prefix) || /\{%[^%]*$/.test(prefix)) return undefined;

		const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
		if (!wordRange) return undefined;
		const word = document.getText(wordRange);
		if (DEFINITION_SQL_KEYWORDS.has(word.toUpperCase())) return undefined;

		// Detect alias.column pattern
		const nearby = line.substring(Math.max(0, wordRange.start.character - 40), wordRange.end.character + 40);
		const dotMatch = /(\w+)\.(\w+)/.exec(nearby);
		let targetAlias: string | undefined;
		let targetColumn: string | undefined;

		if (dotMatch) {
			const dotOffset = nearby.indexOf(dotMatch[0]);
			const absStart = Math.max(0, wordRange.start.character - 40) + dotOffset;
			const aliasEnd = absStart + dotMatch[1].length;
			const colStart = aliasEnd + 1;
			const colEnd = colStart + dotMatch[2].length;

			if (position.character >= colStart && position.character <= colEnd) {
				targetAlias = dotMatch[1];
				targetColumn = dotMatch[2];
			} else if (position.character >= absStart && position.character <= aliasEnd) {
				targetAlias = dotMatch[1];
			}
		}

		// Verify alias exists in scope
		const aliases = await this.columnResolver!.getScopeAliases(document, token);
		if (token.isCancellationRequested) return undefined;

		if (targetAlias) {
			const cols = aliases[targetAlias] ?? aliases[targetAlias.toLowerCase()];
			if (!cols) return undefined;

			return this._jumpToCte(document, targetAlias, targetColumn);
		}

		// Bare column name (no alias prefix) — find first alias that provides it
		for (const [alias, cols] of Object.entries(aliases)) {
			if (cols.some(c => c.toLowerCase() === word.toLowerCase())) {
				return this._jumpToCte(document, alias, word);
			}
		}

		return undefined;
	}

	private _jumpToCte(
		document: vscode.TextDocument,
		alias: string,
		column?: string,
	): vscode.Location | undefined {
		const text = document.getText();
		const ctePattern = new RegExp(`\\b${this._escapeRegex(alias)}\\s+as\\s*\\(`, 'gi');
		const cteMatch = ctePattern.exec(text);
		if (!cteMatch) {
			this.logger.debug(`Definition: no CTE found for alias '${alias}'`);
			return undefined;
		}

		const ctePos = document.positionAt(cteMatch.index);

		if (column) {
			const columnLoc = this._findColumnInCteSelect(document, text, cteMatch.index + cteMatch[0].length, column);
			if (columnLoc) {
				this.logger.debug(`Definition: column '${column}' in CTE '${alias}' → line ${columnLoc.line + 1}`);
				return new vscode.Location(document.uri, columnLoc);
			}
		}

		this.logger.debug(`Definition: CTE '${alias}' → line ${ctePos.line + 1}`);
		return new vscode.Location(document.uri, ctePos);
	}

	private _findColumnInCteSelect(
		document: vscode.TextDocument,
		text: string,
		cteBodyStart: number,
		column: string,
	): vscode.Position | undefined {
		// Search within the CTE body for the column as an alias:
		//   expression AS column_name
		//   or bare column_name in SELECT
		const searchEnd = Math.min(cteBodyStart + 5000, text.length);
		const body = text.substring(cteBodyStart, searchEnd);

		// Look for "AS column_name" pattern
		const asPattern = new RegExp(`\\bas\\s+${this._escapeRegex(column)}\\b`, 'gi');
		const asMatch = asPattern.exec(body);
		if (asMatch) {
			const absOffset = cteBodyStart + asMatch.index + asMatch[0].length - column.length;
			return document.positionAt(absOffset);
		}

		// Look for bare column_name after SELECT (before FROM)
		const fromIdx = body.search(/\bFROM\b/i);
		const selectBody = fromIdx > 0 ? body.substring(0, fromIdx) : body.substring(0, 500);
		const barePattern = new RegExp(`\\b${this._escapeRegex(column)}\\b`, 'gi');
		const bareMatch = barePattern.exec(selectBody);
		if (bareMatch) {
			const absOffset = cteBodyStart + bareMatch.index;
			return document.positionAt(absOffset);
		}

		return undefined;
	}

	private _escapeRegex(str: string): string {
		return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}

const DEFINITION_SQL_KEYWORDS = new Set([
	'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'ON', 'AS',
	'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
	'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
	'WITH', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BETWEEN',
	'LIKE', 'IS', 'NULL', 'TRUE', 'FALSE', 'DISTINCT', 'ALL',
]);
