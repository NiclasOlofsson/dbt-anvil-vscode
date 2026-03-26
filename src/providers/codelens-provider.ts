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

		if (document.languageId === 'yaml' || document.languageId === 'jinja-yaml') {
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
		const lines = document.getText().split('\n');

		let context: 'none' | 'models' | 'data_tests' | 'unit_tests' = 'none';
		let currentModelName: string | undefined;
		let blockIndent = 0;

		// Track the current unit test entry for extracting its model field
		let unitTestName: string | undefined;
		let unitTestLine = -1;
		let unitTestModelName: string | undefined;
		let isCteTest = false;

		const flushUnitTest = (): void => {
			if (unitTestName && unitTestLine >= 0) {
				const range = new vscode.Range(unitTestLine, 0, unitTestLine, lines[unitTestLine].length);
				if (isCteTest) {
					lenses.push(
						new vscode.CodeLens(range, {
							title: '$(combine) Run CTE Test',
							command: 'dbt-studio.runCteTest',
							arguments: [document.fileName, unitTestName],
							tooltip: `Generate and run CTE test: ${unitTestName}`,
						}),
					);
				} else {
					const modelRef = unitTestModelName ?? currentModelName;
					const selector = modelRef
						? `${modelRef},test_type:unit,test_name:${unitTestName}`
						: unitTestName;
					lenses.push(
						new vscode.CodeLens(range, {
							title: '$(beaker) Run Unit Test',
							command: 'dbt-studio.runUnitTest',
							arguments: [modelRef ?? '', unitTestName],
							tooltip: `dbt test --select ${selector}`,
						}),
					);
				}
			}
			unitTestName = undefined;
			unitTestLine = -1;
			unitTestModelName = undefined;
			isCteTest = false;
		};

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			const trimmed = line.trimStart();
			const lineIndent = line.length - trimmed.length;

			// ---- Top-level block detection (indent 0) ----
			if (lineIndent === 0 && trimmed.length > 0) {
				// Flush any pending unit test before switching context
				if (context === 'unit_tests') {
					flushUnitTest();
				}

				if (/^unit_tests:\s*$/.test(trimmed)) {
					context = 'unit_tests';
					blockIndent = 0;
					currentModelName = undefined;
					continue;
				}
				if (/^models:\s*$/.test(trimmed)) {
					context = 'models';
					blockIndent = 0;
					currentModelName = undefined;
					continue;
				}
				// Any other top-level key resets context
				if (/^\w+.*:\s*$/.test(trimmed)) {
					context = 'none';
					currentModelName = undefined;
					continue;
				}
			}

			// ---- Models block: detect model names and nested tests ----
			if (context === 'models') {
				// Model name: "  - name: orders"
				const modelNameMatch = /^(\s+)-\s+name:\s+(\S+)/.exec(line);
				if (modelNameMatch && lineIndent <= 4) {
					currentModelName = modelNameMatch[2];

					if (this.indexer.findModelsByName(currentModelName).length > 0) {
						const range = new vscode.Range(i, 0, i, line.length);
						lenses.push(
							new vscode.CodeLens(range, {
								title: '$(run) Run',
								command: 'dbt-studio.runNamedModel',
								arguments: [currentModelName],
								tooltip: `dbt run -s ${currentModelName}`,
							}),
							new vscode.CodeLens(range, {
								title: '$(beaker) Test',
								command: 'dbt-studio.testNamedModel',
								arguments: [currentModelName],
								tooltip: `dbt test -s ${currentModelName}`,
							}),
						);
					}
				}

				// Nested data_tests: or tests: block
				if (/^\s+data_tests:\s*$/.test(line) || /^\s+tests:\s*$/.test(line)) {
					context = 'data_tests';
					blockIndent = lineIndent;
					continue;
				}
			}

			// ---- Data tests block ----
			if (context === 'data_tests') {
				// Exit if de-indented past block
				if (lineIndent <= blockIndent && trimmed.length > 0 && !trimmed.startsWith('-')) {
					context = 'models';
					// Re-process this line in models context
					i--;
					continue;
				}

				if (currentModelName) {
					const dtMatch = /^\s+-\s+(\w+):\s*$/.exec(line);
					if (dtMatch) {
						const range = new vscode.Range(i, 0, i, line.length);
						lenses.push(
							new vscode.CodeLens(range, {
								title: '$(beaker) Run Test',
								command: 'dbt-studio.testNamedModel',
								arguments: [currentModelName],
								tooltip: `dbt test -s ${currentModelName}`,
							}),
						);
					}
				}
			}

			// ---- Unit tests block (top-level) ----
			if (context === 'unit_tests') {
				// New unit test entry: "  - name: test_something"
				const utNameMatch = /^\s+-\s+name:\s+(\S+)/.exec(line);
				if (utNameMatch) {
					// Flush previous unit test
					flushUnitTest();
					unitTestName = utNameMatch[1];
					unitTestLine = i;
					unitTestModelName = undefined;
					continue;
				}

				// Model field inside a unit test: "    model: dim_customers" or "    model: base_model::cte_name"
				if (unitTestName) {
					const modelMatch = /^\s+model:\s+(\S+)/.exec(line);
					if (modelMatch) {
						unitTestModelName = modelMatch[1];
					}
					// Detect cte_test: true inside config block
					if (/^\s+cte_test:\s+true/.test(line)) {
						isCteTest = true;
					}
				}
			}
		}

		// Flush any pending unit test at end of file
		if (context === 'unit_tests') {
			flushUnitTest();
		}

		return lenses;
	}

	private _getModelName(document: vscode.TextDocument): string | undefined {
		const fileName = document.fileName.split(/[\\/]/).pop();
		if (!fileName) return undefined;
		return fileName.replace(/\.sql$/, '');
	}
}
