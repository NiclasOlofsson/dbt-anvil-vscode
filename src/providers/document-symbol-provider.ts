import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ParseService } from '../services/parse-service';
import type { ILogger } from '../types/logger';

/**
 * Document symbols for the Outline panel.
 * SQL files: CTEs shown as named symbols, backed by bridge-parsed DocumentModel
 *            with accurate line ranges and column children (falls back to regex
 *            if the bridge hasn't started yet or parsing fails).
 * YAML files: model → columns → tests hierarchy.
 */
export class DbtDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService | null = null,
	) {}

	provideDocumentSymbols(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.DocumentSymbol[]> {
		if (document.languageId === 'jinja-sql') {
			return this._sqlSymbols(document);
		}

		if (document.languageId === 'yaml') {
			return this._yamlSymbols(document);
		}

		return [];
	}

	private async _sqlSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
		if (this.parseService) {
			const dialect = this.indexer.index?.adapterType ?? 'ansi';
			const model = await this.parseService.getDocumentModel(document, dialect);
			if (model) {
				return this._symbolsFromModel(document, model);
			}
		}

		// Fallback: regex-based extraction
		return this._sqlSymbolsRegex(document);
	}

	private _symbolsFromModel(
		document: vscode.TextDocument,
		model: import('../services/parse-service').DocumentModel,
	): vscode.DocumentSymbol[] {
		if (model.ctes.length === 0 && model.finalColumns.length === 0) return [];

		const symbols: vscode.DocumentSymbol[] = [];
		const lineCount = document.lineCount;

		for (const cte of model.ctes) {
			const startLine = Math.min(cte.line, lineCount - 1);
			const endLine = Math.min(cte.endLine, lineCount - 1);
			const startPos = new vscode.Position(startLine, 0);
			const endPos = document.lineAt(endLine).range.end;
			const range = new vscode.Range(startPos, endPos);
			const selectionRange = document.lineAt(startLine).range;

			const sym = new vscode.DocumentSymbol(
				cte.name,
				'CTE',
				vscode.SymbolKind.Function,
				range,
				selectionRange,
			);

			// Add columns as children, navigating to the actual column line
			for (const col of cte.columns) {
				const colLine = Math.min(col.line, lineCount - 1);
				const colRange = document.lineAt(colLine).range;
				const childSym = new vscode.DocumentSymbol(
					col.name,
					'column',
					vscode.SymbolKind.Field,
					colRange,
					colRange,
				);
				sym.children.push(childSym);
			}

			symbols.push(sym);
		}

		// Final SELECT symbol — find the final SELECT start line
		const modelName = this._getModelName(document);
		if (modelName && model.finalColumns.length > 0) {
			const lastLine = lineCount - 1;
			// Try to find the final SELECT: the last SELECT that isn't inside a CTE.
			// Simple heuristic: scan backwards from end for a line starting with "select".
			let finalSelectLine = lastLine;
			for (let i = lastLine; i >= 0; i--) {
				if (/^\s*select\b/i.test(document.lineAt(i).text)) {
					finalSelectLine = i;
					break;
				}
			}
			const startPos = new vscode.Position(finalSelectLine, 0);
			const endPos = document.lineAt(lastLine).range.end;
			const range = new vscode.Range(startPos, endPos);
			const selectionRange = document.lineAt(finalSelectLine).range;
			const finalSym = new vscode.DocumentSymbol(
				modelName,
				'final query',
				vscode.SymbolKind.Class,
				range,
				selectionRange,
			);
			for (const col of model.finalColumns) {
				const colLine = Math.min(col.line, lineCount - 1);
				const colRange = document.lineAt(colLine).range;
				const childSym = new vscode.DocumentSymbol(
					col.name,
					'output column',
					vscode.SymbolKind.Field,
					colRange,
					colRange,
				);
				finalSym.children.push(childSym);
			}
			symbols.push(finalSym);
		}

		this.logger.debug(
			'[parse-service] DocumentSymbol: '
			+ symbols.length + ' symbols from DocumentModel in ' + document.fileName,
		);
		return symbols;
	}

	private _sqlSymbolsRegex(document: vscode.TextDocument): vscode.DocumentSymbol[] {
		const text = document.getText();
		const symbols: vscode.DocumentSymbol[] = [];

		// Extract CTE names: `name AS (` pattern — handles Jinja-heavy SQL
		const cteRe = /\b(\w+)\s+as\s*\(/gi;
		// First check if there's a WITH keyword
		const withRe = /\bwith\b/i;
		if (!withRe.test(text)) return symbols;

		let match;
		while ((match = cteRe.exec(text)) !== null) {
			const name = match[1];
			// Skip SQL keywords that look like CTEs
			if (/^(select|from|where|join|left|right|inner|outer|full|cross|on|and|or|not|in|as|case|when|then|else|end|group|order|having|limit|union|intersect|except|with|values|insert|update|delete|set|into|create|alter|drop|table|view|index|if|exists|between|like|is|null|true|false|asc|desc|by|distinct|all|any|some)$/i.test(name)) {
				continue;
			}

			const pos = document.positionAt(match.index);
			const endPos = document.positionAt(match.index + match[0].length);
			const range = new vscode.Range(pos, endPos);

			symbols.push(new vscode.DocumentSymbol(
				name,
				'CTE',
				vscode.SymbolKind.Function,
				range,
				range,
			));
		}

		// Add the final SELECT as a symbol if CTEs were found
		if (symbols.length > 0) {
			const modelName = this._getModelName(document);
			if (modelName) {
				// Find the last SELECT that isn't inside a CTE
				const lastSelectRe = /\bselect\b/gi;
				let lastSelect;
				while ((match = lastSelectRe.exec(text)) !== null) {
					lastSelect = match;
				}
				if (lastSelect) {
					const pos = document.positionAt(lastSelect.index);
					const range = new vscode.Range(pos, pos);
					symbols.push(new vscode.DocumentSymbol(
						modelName,
						'final query',
						vscode.SymbolKind.Class,
						range,
						range,
					));
				}
			}
		}

		this.logger.debug('DocumentSymbol: ' + symbols.length + ' SQL symbols (regex) in ' + document.fileName);
		return symbols;
	}

	private _yamlSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
		const text = document.getText();
		const lines = text.split('\n');
		const symbols: vscode.DocumentSymbol[] = [];

		let currentModel: vscode.DocumentSymbol | undefined;
		let inColumnsBlock = false;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Model: `  - name: model_name`
			const modelMatch = /^(\s{2,4})-\s+name:\s+(\S+)/.exec(line);
			if (modelMatch && !inColumnsBlock) {
				const range = new vscode.Range(i, 0, i, line.length);
				currentModel = new vscode.DocumentSymbol(
					modelMatch[2],
					'model',
					vscode.SymbolKind.Class,
					range,
					range,
				);
				symbols.push(currentModel);
				inColumnsBlock = false;
				continue;
			}

			// columns: block
			if (/^\s+columns:\s*$/.test(line)) {
				inColumnsBlock = true;
				continue;
			}

			// New block at same or lower indent — exit columns
			if (inColumnsBlock && /^\s{2,4}\w/.test(line) && !/^\s+-/.test(line)) {
				inColumnsBlock = false;
			}

			// Column: `      - name: column_name`
			if (inColumnsBlock && currentModel) {
				const colMatch = /^\s+-\s+name:\s+(\S+)/.exec(line);
				if (colMatch) {
					const range = new vscode.Range(i, 0, i, line.length);
					const colSymbol = new vscode.DocumentSymbol(
						colMatch[1],
						'column',
						vscode.SymbolKind.Field,
						range,
						range,
					);
					currentModel.children.push(colSymbol);
				}
			}
		}

		this.logger.debug(`DocumentSymbol: ${symbols.length} YAML symbols in ${document.fileName}`);
		return symbols;
	}

	private _getModelName(document: vscode.TextDocument): string | undefined {
		const fileName = document.fileName.split(/[\\/]/).pop();
		if (!fileName) return undefined;
		return fileName.replace(/\.sql$/, '');
	}
}
