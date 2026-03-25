import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * CodeLens above dbt SQL model files: Run | Build | Test | Compile.
 * Also shows Run Test above test entries in schema.yml.
 */
export class DbtCodeLensProvider implements vscode.CodeLensProvider {
	private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
	readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	refresh(): void {
		this._onDidChangeCodeLenses.fire();
	}

	provideCodeLenses(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.CodeLens[] {
		if (document.languageId === 'jinja-sql') {
			return this._sqlCodeLenses(document);
		}

		if (document.languageId === 'yaml') {
			return this._yamlCodeLenses(document);
		}

		return [];
	}

	private _sqlCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const modelName = this._getModelName(document);
		if (!modelName) return [];

		// Only show lenses for models known in the manifest
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return [];

		const topRange = new vscode.Range(0, 0, 0, 0);
		this.logger.debug(`CodeLens: adding lenses for model '${modelName}'`);

		return [
			new vscode.CodeLens(topRange, {
				title: '$(run) Run',
				command: 'dbt-studio.runModel',
				tooltip: `dbt run -s ${modelName}`,
			}),
			new vscode.CodeLens(topRange, {
				title: '$(package) Build',
				command: 'dbt-studio.buildModel',
				tooltip: `dbt build -s ${modelName}`,
			}),
			new vscode.CodeLens(topRange, {
				title: '$(beaker) Test',
				command: 'dbt-studio.testModel',
				tooltip: `dbt test -s ${modelName}`,
			}),
			new vscode.CodeLens(topRange, {
				title: '$(gear) Compile',
				command: 'dbt-studio.compileModel',
				tooltip: `dbt compile -s ${modelName}`,
			}),
		];
	}

	private _yamlCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
		const lenses: vscode.CodeLens[] = [];
		const text = document.getText();
		const lines = text.split('\n');

		// Find test entries: lines that match "- name: X" under a tests: block
		// or data_tests: block, or lines with "- dbt_utils." etc.
		const testLineRe = /^(\s+)-\s+(\w+):\s*$/;
		const modelNameRe = /^\s+-\s+name:\s+(\S+)/;
		let inTestsBlock = false;
		let currentModel: string | undefined;

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];

			// Track current model name
			const modelMatch = modelNameRe.exec(line);
			if (modelMatch) {
				currentModel = modelMatch[1];
			}

			// Detect tests: or data_tests: block
			if (/^\s+tests:\s*$/.test(line) || /^\s+data_tests:\s*$/.test(line)) {
				inTestsBlock = true;
				continue;
			}

			// Exit tests block on non-indented or different block
			if (inTestsBlock && /^\s+\w+:/.test(line) && !/^\s+-/.test(line)) {
				inTestsBlock = false;
			}

			if (inTestsBlock && currentModel) {
				const testMatch = testLineRe.exec(line);
				if (testMatch) {
					const range = new vscode.Range(i, 0, i, line.length);
					lenses.push(new vscode.CodeLens(range, {
						title: '$(beaker) Run Test',
						command: 'dbt-studio.testModel',
						tooltip: `dbt test -s ${currentModel}`,
					}));
				}
			}
		}

		return lenses;
	}

	private _getModelName(document: vscode.TextDocument): string | undefined {
		const fileName = document.fileName.split(/[\\/]/).pop();
		if (!fileName) return undefined;
		return fileName.replace(/\.sql$/, '');
	}
}
