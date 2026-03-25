import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Document symbols for the Outline panel.
 * SQL files: CTEs shown as named symbols.
 * YAML files: model → columns → tests hierarchy.
 */
export class DbtDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideDocumentSymbols(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.DocumentSymbol[] {
		if (document.languageId === 'jinja-sql') {
			return this._sqlSymbols(document);
		}

		if (document.languageId === 'yaml') {
			return this._yamlSymbols(document);
		}

		return [];
	}

	private _sqlSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
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

		this.logger.debug(`DocumentSymbol: ${symbols.length} SQL symbols in ${document.fileName}`);
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
