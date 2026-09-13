import * as vscode from 'vscode';
import type { ILogger } from '../../types/logger';
import { DbtSymbolKind } from '../common/icons';

/**
 * Document symbols for the Outline panel in YAML schema files.
 * Shows model → column hierarchy via regex-based line walking.
 */
export class YamlDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	constructor(
		private readonly logger: ILogger,
	) { }

	provideDocumentSymbols(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.DocumentSymbol[]> {
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.documentSymbols', true)) return [];
		return this._yamlSymbols(document);
	}

	private _yamlSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
		const text = document.getText();
		const lines = text.split('\n');
		const symbols: vscode.DocumentSymbol[] = [];

		let currentModel: vscode.DocumentSymbol | undefined;
		let inColumnsBlock = false;
		let currentTopLevelKey: string | undefined;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Track the current top-level key (`models:`, `sources:`, `functions:`, ...)
			const topLevelMatch = /^(\w+):\s*$/.exec(line);
			if (topLevelMatch) {
				currentTopLevelKey = topLevelMatch[1];
			}

			// Model / function: `  - name: resource_name`
			const modelMatch = /^(\s{2,4})-\s+name:\s+(\S+)/.exec(line);
			if (modelMatch && !inColumnsBlock) {
				const isFunction = currentTopLevelKey === 'functions';
				const range = new vscode.Range(i, 0, i, line.length);
				currentModel = new vscode.DocumentSymbol(
					modelMatch[2],
					isFunction ? 'function' : 'model',
					isFunction ? DbtSymbolKind.function : vscode.SymbolKind.Class,
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
}
