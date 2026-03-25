import * as vscode from 'vscode';
import { VSCodeLogger } from './types/logger';
import { ServiceContainer } from './types/service-container';
import { ManifestLoader } from './dbt/manifest-loader';
import { ManifestIndexer } from './indexing/manifest-indexer';
import { ManifestWatcher } from './indexing/manifest-watcher';
import { detectPythonEnvironment } from './dbt/env-detector';
import { BridgeRunner } from './dbt/bridge-runner';
import { DbtExecutionService, Priority } from './dbt/execution-service';
import { registerLanguageModelTools } from './tools';
import { ModelExplorerProvider } from './views/model-explorer-provider';
import { TestResultsProvider } from './views/test-results-provider';
import { DbtDefinitionProvider } from './providers/definition-provider';
import { DbtHoverProvider } from './providers/hover-provider';
import { DbtCompletionProvider } from './providers/completion-provider';
import { YamlCompletionProvider } from './providers/yaml-completion-provider';
import { YamlHoverProvider } from './providers/yaml-hover-provider';
import { StatusBarManager } from './views/status-bar';
import { DbtDiagnosticsProvider } from './providers/diagnostics-provider';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// -------- Bootstrap logging & service container --------
	const outputChannel = vscode.window.createOutputChannel('dbt Studio', { log: true });

	if (context.extensionMode === vscode.ExtensionMode.Development) {
		outputChannel.show(true);
	}

	const logger = new VSCodeLogger(outputChannel, context.extensionMode);

	const version = (context.extension.packageJSON as { version: string }).version;
	ServiceContainer.initialize({ extensionContext: context, logger, extensionVersion: version });
	context.subscriptions.push(outputChannel);

	logger.info(`dbt Studio v${version} activating...`);

	// -------- Resolve workspace/project directory --------
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		logger.warn('No workspace folder open — dbt Studio may be limited.');
		return;
	}

	const projectDir = workspaceFolders[0].uri.fsPath;

	// -------- Detect Python environment --------
	const pythonEnv = detectPythonEnvironment(projectDir);
	logger.info(`Python environment: ${pythonEnv.description} (${pythonEnv.command.join(' ')})`);

	// -------- Set up manifest loading and indexing --------
	const manifestLoader = new ManifestLoader(projectDir);
	const manifestIndexer = new ManifestIndexer(manifestLoader, logger);

	const container = ServiceContainer.getInstance();
	container.setManifestLoader(manifestLoader);
	container.setManifestIndexer(manifestIndexer);

	// Try to build index on activation if manifest exists
	if (manifestLoader.manifestExists()) {
		try {
			manifestIndexer.build();
		} catch (err) {
			logger.warn(`Could not load manifest on startup: ${err}`);
		}
	} else {
		logger.info('No manifest.json found. Run dbt parse/compile to generate it.');
	}

	// -------- File watcher --------
	const manifestWatcher = new ManifestWatcher(manifestLoader, manifestIndexer, logger);
	manifestWatcher.start(projectDir);
	container.setManifestWatcher(manifestWatcher);
	context.subscriptions.push({ dispose: () => manifestWatcher.dispose() });

	// -------- Python bridge (lazy-started on first use) --------
	const bridgePyPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'bridge', 'bridge.py').fsPath;
	const bridgeRunner = new BridgeRunner(bridgePyPath, projectDir, pythonEnv, logger);
	container.setBridgeRunner(bridgeRunner);
	context.subscriptions.push({ dispose: () => void bridgeRunner.shutdown() });

	// -------- Execution service (priority queue around bridge) --------
	const executionService = new DbtExecutionService(bridgeRunner, manifestLoader, manifestWatcher, logger);
	container.setExecutionService(executionService);
	context.subscriptions.push({ dispose: () => executionService.dispose() });

	// Connect manifest watcher to execution service for background parse-on-save
	manifestWatcher.setExecutionService(executionService);

	// -------- Status bar --------
	const statusBar = new StatusBarManager(executionService, logger);
	context.subscriptions.push(statusBar);

	// -------- Diagnostics provider --------
	const diagnosticsProvider = new DbtDiagnosticsProvider(executionService, statusBar, projectDir, logger);
	context.subscriptions.push(diagnosticsProvider);

	// -------- Set workspaceHasDBT context --------
	void vscode.commands.executeCommand('setContext', 'workspaceHasDBT', manifestLoader.manifestExists());

	// -------- Register Copilot language model tools --------
	registerLanguageModelTools(context, manifestIndexer, executionService, manifestLoader, logger);

	// -------- Register tree views --------
	const modelExplorerProvider = new ModelExplorerProvider(manifestIndexer, logger);
	const testResultsProvider = new TestResultsProvider(logger);
	context.subscriptions.push(
		vscode.window.registerTreeDataProvider('dbt-studio.modelExplorer', modelExplorerProvider),
		vscode.window.registerTreeDataProvider('dbt-studio.testResults', testResultsProvider),
	);

	// -------- Register language providers --------
	const sqlSelector: vscode.DocumentSelector = { language: 'jinja-sql' };
	const yamlSelector: vscode.DocumentSelector = { language: 'yaml', pattern: '**/{schema,sources,models}.yml' };
	const definitionProvider = new DbtDefinitionProvider(manifestIndexer, manifestLoader, logger);
	const hoverProvider = new DbtHoverProvider(manifestIndexer, logger);
	const completionProvider = new DbtCompletionProvider(manifestIndexer, logger, executionService);
	const yamlCompletionProvider = new YamlCompletionProvider(manifestIndexer, logger);
	const yamlHoverProvider = new YamlHoverProvider(manifestIndexer, logger);

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(sqlSelector, definitionProvider),
		vscode.languages.registerHoverProvider(sqlSelector, hoverProvider),
		vscode.languages.registerCompletionItemProvider(sqlSelector, completionProvider, '\'', '"', '.'),
		vscode.languages.registerCompletionItemProvider(yamlSelector, yamlCompletionProvider),
		vscode.languages.registerHoverProvider(yamlSelector, yamlHoverProvider),
		// Formatting and diagnostics for jinja-sql are delegated to the SQLFluff extension.
		// See src/providers/formatting-provider.ts and src/providers/diagnostics-provider.ts
		// for details and instructions on implementing them here if ever needed.
	);

	// -------- Register commands --------
	context.subscriptions.push(
		vscode.commands.registerCommand('dbt-studio.refreshManifest', () => {
			manifestLoader.invalidate();
			completionProvider.invalidateScopeCache();
			try {
				manifestIndexer.build(true);
				modelExplorerProvider.refresh();
				void vscode.window.showInformationMessage('dbt Studio: Manifest refreshed.');
			} catch (err) {
				void vscode.window.showErrorMessage(`dbt Studio: Failed to refresh manifest — ${err}`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.refreshExplorer', () => {
			modelExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-studio.runModel', async () => {
			const model = getActiveModelName();
			if (!model) return;
			const result = await executionService.submit({
				type: 'run', args: ['run', '-s', model],
				priority: Priority.User, origin: 'user', label: `run ${model}`,
			});
			if (result.success) {
				void vscode.window.showInformationMessage(`dbt run ${model}: success`);
			} else {
				void vscode.window.showErrorMessage(`dbt run ${model}: failed — ${result.stderr}`);
			}
			modelExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-studio.testModel', async () => {
			const model = getActiveModelName();
			if (!model) return;
			const result = await executionService.submit({
				type: 'test', args: ['test', '-s', model],
				priority: Priority.User, origin: 'user', label: `test ${model}`,
			});
			if (result.success) {
				void vscode.window.showInformationMessage(`dbt test ${model}: success`);
			} else {
				void vscode.window.showErrorMessage(`dbt test ${model}: failed — ${result.stderr}`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.buildModel', async () => {
			const model = getActiveModelName();
			if (!model) return;
			const result = await executionService.submit({
				type: 'build', args: ['build', '-s', model],
				priority: Priority.User, origin: 'user', label: `build ${model}`,
			});
			if (result.success) {
				void vscode.window.showInformationMessage(`dbt build ${model}: success`);
			} else {
				void vscode.window.showErrorMessage(`dbt build ${model}: failed — ${result.stderr}`);
			}
			modelExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-studio.compileModel', async () => {
			const model = getActiveModelName();
			if (!model) return;
			const result = await executionService.submit({
				type: 'compile', args: ['compile', '-s', model],
				priority: Priority.User, origin: 'user', label: `compile ${model}`,
			});
			if (result.success) {
				try {
					const { manifest } = manifestLoader.load(true);
					for (const node of Object.values(manifest.nodes)) {
						if (node.name === model && node.compiled_code) {
							const doc = await vscode.workspace.openTextDocument({
								content: node.compiled_code,
								language: 'sql',
							});
							await vscode.window.showTextDocument(doc, { preview: true });
							return;
						}
					}
				} catch {
					// Fall through
				}
				void vscode.window.showInformationMessage(`dbt compile ${model}: success (see output)`);
			} else {
				void vscode.window.showErrorMessage(`dbt compile ${model}: failed — ${result.stderr}`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.showLineage', () => {
			const model = getActiveModelName();
			if (!model) return;
			const models = manifestIndexer.findModelsByName(model);
			if (models.length === 0) {
				void vscode.window.showWarningMessage(`Model "${model}" not found in manifest.`);
				return;
			}
			const lineage = manifestIndexer.getLineage(models[0].uniqueId, 3);
			const text = [
				`Lineage for: ${model}`,
				'',
				'Upstream:',
				...lineage.upstream.map(u => `  ← ${u}`),
				lineage.upstream.length === 0 ? '  (none)' : '',
				'Downstream:',
				...lineage.downstream.map(d => `  → ${d}`),
				lineage.downstream.length === 0 ? '  (none)' : '',
			].join('\n');
			void vscode.workspace.openTextDocument({ content: text }).then(doc =>
				vscode.window.showTextDocument(doc, { preview: true }),
			);
		}),

		vscode.commands.registerCommand('dbt-studio.runDeps', async () => {
			const result = await executionService.submit({
				type: 'deps', args: ['deps'],
				priority: Priority.User, origin: 'user', label: 'install deps',
			});
			if (result.success) {
				void vscode.window.showInformationMessage('dbt deps: success');
			} else {
				void vscode.window.showErrorMessage(`dbt deps: failed — ${result.stderr}`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.parseProject', async () => {
			const result = await executionService.submit({
				type: 'parse', args: ['parse'],
				priority: Priority.User, origin: 'user', label: 'parse project',
			});
			if (result.success) {
				try {
					manifestIndexer.build(true);
					modelExplorerProvider.refresh();
				} catch {
					// Index rebuild may fail if manifest is still invalid
				}
				void vscode.window.showInformationMessage('dbt parse: success');
			} else {
				void vscode.window.showErrorMessage(`dbt parse: failed — ${result.stderr}`);
			}
		}),
	);

	logger.info(`dbt Studio v${version} activated.`);
}

function getActiveModelName(): string | undefined {
	const editor = vscode.window.activeTextEditor;
	if (!editor) {
		void vscode.window.showWarningMessage('No active editor. Open a dbt model file first.');
		return undefined;
	}
	const fileName = editor.document.fileName;
	const base = fileName.split(/[\\/]/).pop();
	if (!base) return undefined;
	return base.replace(/\.sql$/, '');
}

export async function deactivate(): Promise<void> {
	if (ServiceContainer.isInitialized()) {
		const container = ServiceContainer.getInstance();
		await container.getBridgeRunner().shutdown().catch(() => undefined);
		ServiceContainer.reset();
	}
}
