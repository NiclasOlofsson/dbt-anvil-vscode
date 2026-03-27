import * as vscode from 'vscode';
import { VSCodeLogger } from './types/logger';
import { ServiceContainer } from './types/service-container';
import { ManifestLoader } from './dbt/manifest-loader';
import { ManifestIndexer } from './indexing/manifest-indexer';
import { ManifestWatcher } from './indexing/manifest-watcher';
import { detectPythonEnvironment, detectProfilesDir } from './dbt/env-detector';
import { BridgeRunner } from './dbt/bridge-runner';
import { DbtExecutionService, Priority } from './dbt/execution-service';
import { CompileCache } from './dbt/compile-cache';
import { CompileCachePersistence } from './dbt/compile-cache-persistence';
import { DescribeCache } from './dbt/describe-cache';
import { ScopeColumnsCache } from './dbt/scope-columns-cache';
import { loadProjectConfig } from './dbt/project-config';
import { createDatabaseProvider } from './providers/database/database-provider-factory';
import { ColumnStorePersistence } from './indexing/column-store-persistence';
import { registerLanguageModelTools } from './tools';
import { GetColumnLineageTool } from './tools/get-column-lineage';
import { ModelExplorerProvider } from './views/model-explorer-provider';
import { TestResultsProvider } from './views/test-results-provider';
import { LineageGraphProvider } from './views/lineage-graph-provider';
import { TestExplorerProvider } from './views/test-explorer-provider';
import { DbtDefinitionProvider } from './providers/definition-provider';
import { DbtHoverProvider } from './providers/hover-provider';
import { DbtCompletionProvider } from './providers/completion-provider';
import { YamlCompletionProvider } from './providers/yaml-completion-provider';
import { YamlHoverProvider } from './providers/yaml-hover-provider';
import { DbtReferenceProvider } from './providers/reference-provider';
import { DbtRenameProvider } from './providers/rename-provider';
import { DbtCodeLensProvider } from './providers/codelens-provider';
import { DbtDocumentSymbolProvider } from './providers/document-symbol-provider';
import { DbtWorkspaceSymbolProvider } from './providers/workspace-symbol-provider';
import { DbtSignatureHelpProvider } from './providers/signature-help-provider';
import { DbtCodeActionProvider } from './providers/code-action-provider';
import { ParseService } from './services/parse-service';
import { StatusBarManager } from './views/status-bar';
import { DbtDiagnosticsProvider } from './providers/diagnostics-provider';
import { ColumnResolver } from './providers/column-resolver';
import { VsTestController } from './views/vs-test-controller';
import { CteTestRunner } from './dbt/cte-test-runner';

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

	// -------- Column store persistence --------
	const columnStorePersistence = new ColumnStorePersistence(context, logger);
	// Restore before first build so _diffAndInvalidate only evicts changed nodes
	columnStorePersistence.restore(manifestIndexer);

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
	context.subscriptions.push({ dispose: () => columnStorePersistence.save(manifestIndexer) });

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

	// -------- Compile cache (shared across all tools) --------
	const compileCache = new CompileCache(executionService, manifestLoader, logger);
	const compileCachePersistence = new CompileCachePersistence(context, logger);
	const restoredCompileEntries = compileCachePersistence.restore(compileCache);
	context.subscriptions.push({ dispose: () => compileCachePersistence.save(compileCache) });

	// -------- Describe cache (shared across providers and tools) --------
	const describeCache = new DescribeCache(executionService, manifestIndexer, logger);

	// -------- Database provider (direct warehouse access, bypasses dbt bridge queue) --------
	const projectConfig = loadProjectConfig(projectDir);
	const profileName = projectConfig?.profile ?? 'default';
	const profilesDir = detectProfilesDir(projectDir);
	const adapterType = manifestIndexer.index?.adapterType ?? 'ansi';
	const databaseProvider = await createDatabaseProvider(adapterType, profileName, profilesDir, executionService, logger);
	container.setDatabaseProvider(databaseProvider);
	describeCache.setProvider(databaseProvider);

	// -------- Status bar --------
	const statusBar = new StatusBarManager(executionService, logger);
	context.subscriptions.push(statusBar);

	// Kick off a full compile to warm the cache. Skipped if enough valid entries
	// were restored from disk (mtime validation happens on first access per entry).
	void compileCache.warmAll(projectDir, restoredCompileEntries);

	// -------- Parse service (structural parse + background alias enrichment) --------
	const scopeColumnsCache = new ScopeColumnsCache(executionService, logger);
	const parseService = new ParseService(bridgeRunner, logger, { service: executionService, describeCache, indexer: manifestIndexer, scopeColumnsCache });
	manifestWatcher.setParseService(parseService);

	// -------- Diagnostics provider --------
	const columnResolver = new ColumnResolver(manifestIndexer, logger, parseService);
	const diagnosticsProvider = new DbtDiagnosticsProvider(executionService, manifestIndexer, statusBar, projectDir, logger, columnResolver, parseService.onEnrichmentComplete);
	context.subscriptions.push(diagnosticsProvider);

	// -------- Set workspaceHasDBT context --------
	void vscode.commands.executeCommand('setContext', 'workspaceHasDBT', manifestLoader.manifestExists());

	// -------- Register Copilot language model tools --------
	registerLanguageModelTools(context, manifestIndexer, executionService, manifestLoader, logger, compileCache, databaseProvider);

	// -------- Register tree views --------
	const modelExplorerProvider = new ModelExplorerProvider(manifestIndexer, logger, projectDir);
	const testResultsProvider = new TestResultsProvider(logger);
	const lineageGraphProvider = new LineageGraphProvider(manifestIndexer, logger);
	const columnLineageTool = new GetColumnLineageTool(manifestIndexer, executionService, logger, compileCache);
	lineageGraphProvider.setColumnLineageTool(columnLineageTool);
	lineageGraphProvider.setExecutionService(executionService);
	// Initialise context keys so the correct toolbar icons show from the start
	void vscode.commands.executeCommand('setContext', 'dbt-studio.lineageFollowActive', lineageGraphProvider.followActive);
	void vscode.commands.executeCommand('setContext', 'dbt-studio.lineageShowTests', lineageGraphProvider.showTests);
	const testExplorerProvider = new TestExplorerProvider(manifestIndexer, manifestLoader, logger);

	const modelExplorerView = vscode.window.createTreeView('dbt-studio.modelExplorer', {
		treeDataProvider: modelExplorerProvider,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		modelExplorerView,
		vscode.window.registerTreeDataProvider('dbt-studio.testResults', testResultsProvider),
		vscode.window.registerWebviewViewProvider(LineageGraphProvider.viewId, lineageGraphProvider),
		vscode.window.registerTreeDataProvider('dbt-studio.testExplorer', testExplorerProvider),
	);

	// -------- Native VS Code Testing panel --------
	const cteTestRunner = new CteTestRunner(projectDir, executionService);
	const vsTestController = new VsTestController(testExplorerProvider, executionService, logger, cteTestRunner);
	context.subscriptions.push(vsTestController);

	// Refresh views whenever the manifest index is rebuilt (e.g. after dbt parse on save)
	context.subscriptions.push(
		manifestWatcher.onIndexRebuild(() => {
			testExplorerProvider.refresh();
			lineageGraphProvider.refreshGraph();
			columnStorePersistence.save(manifestIndexer);
		}),
	);

	// -------- Editor follow (sync explorer + lineage) --------
	const revealModelForEditor = (editor: vscode.TextEditor | undefined) => {
		if (!editor) return;
		const uid = manifestIndexer.findModelByFilePath(editor.document.fileName);
		if (!uid) return;

		const item = modelExplorerProvider.findModelItemForReveal(uid);
		if (item) {
			void modelExplorerView.reveal(item, { select: true, focus: false });
		}

		if (lineageGraphProvider.followActive) {
			lineageGraphProvider.setFocusModel(uid);
		}
	};

	context.subscriptions.push(
		vscode.window.onDidChangeActiveTextEditor(revealModelForEditor),
		vscode.workspace.onDidCloseTextDocument((doc) => {
			lineageGraphProvider.notifyFileClosed(doc.fileName);
		}),
	);

	// Trigger immediately for the already-active editor on startup
	revealModelForEditor(vscode.window.activeTextEditor);

	// -------- Register language providers --------
	const sqlSelector: vscode.DocumentSelector = { language: 'jinja-sql' };
	const yamlSelector: vscode.DocumentSelector = [
		{ language: 'yaml', pattern: '**/*.{yml,yaml}' },
		{ language: 'jinja-yaml', pattern: '**/*.{yml,yaml}' },
	];
	const definitionProvider = new DbtDefinitionProvider(manifestIndexer, manifestLoader, logger, parseService);
	const hoverProvider = new DbtHoverProvider(manifestIndexer, logger, columnResolver, parseService);
	const completionProvider = new DbtCompletionProvider(manifestIndexer, logger, columnResolver, parseService);
	const yamlCompletionProvider = new YamlCompletionProvider(manifestIndexer, logger);
	const yamlHoverProvider = new YamlHoverProvider(manifestIndexer, logger);
	const referenceProvider = new DbtReferenceProvider(manifestIndexer, logger, columnResolver);
	const renameProvider = new DbtRenameProvider(manifestIndexer, manifestLoader, logger);
	const codeLensProvider = new DbtCodeLensProvider(manifestIndexer, logger);
	const documentSymbolProvider = new DbtDocumentSymbolProvider(manifestIndexer, logger, parseService);
	const workspaceSymbolProvider = new DbtWorkspaceSymbolProvider(manifestIndexer, logger);
	const signatureHelpProvider = new DbtSignatureHelpProvider(manifestIndexer, logger);
	const codeActionProvider = new DbtCodeActionProvider(manifestIndexer, logger);

	context.subscriptions.push(
		vscode.languages.registerDefinitionProvider(sqlSelector, definitionProvider),
		vscode.languages.registerHoverProvider(sqlSelector, hoverProvider),
		vscode.languages.registerCompletionItemProvider(sqlSelector, completionProvider, '\'', '"', '.'),
		vscode.languages.registerCompletionItemProvider(yamlSelector, yamlCompletionProvider),
		vscode.languages.registerHoverProvider(yamlSelector, yamlHoverProvider),
		vscode.languages.registerReferenceProvider(sqlSelector, referenceProvider),
		vscode.languages.registerRenameProvider(sqlSelector, renameProvider),
		vscode.languages.registerCodeLensProvider(sqlSelector, codeLensProvider),
		vscode.languages.registerCodeLensProvider(yamlSelector, codeLensProvider),
		vscode.languages.registerDocumentSymbolProvider(sqlSelector, documentSymbolProvider),
		vscode.languages.registerDocumentSymbolProvider(yamlSelector, documentSymbolProvider),
		vscode.languages.registerWorkspaceSymbolProvider(workspaceSymbolProvider),
		vscode.languages.registerSignatureHelpProvider(sqlSelector, signatureHelpProvider, '(', ','),
		vscode.languages.registerCodeActionsProvider(sqlSelector, codeActionProvider, {
			providedCodeActionKinds: DbtCodeActionProvider.providedCodeActionKinds,
		}),
	);

	// -------- Register commands --------
	context.subscriptions.push(
		vscode.commands.registerCommand('dbt-studio.refreshManifest', () => {
			manifestLoader.invalidate();
			columnResolver.invalidateCache();
			try {
				manifestIndexer.build(true);
				modelExplorerProvider.refresh();
				testExplorerProvider.refresh();
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

			// Use the shared cache — skip compile if file hasn't changed
			const resources = manifestIndexer.findResource(model, 'model');
			const raw = resources.length > 0 ? manifestIndexer.getRawNode(resources[0].uniqueId) : undefined;
			if (raw && raw.resource_type === 'model') {
				const compiledSql = await compileCache.ensureCompiled(
					raw.unique_id, raw.name, manifestIndexer.projectDir, raw.original_file_path,
				);
				if (compiledSql) {
					const doc = await vscode.workspace.openTextDocument({ content: compiledSql, language: 'sql' });
					await vscode.window.showTextDocument(doc, { preview: true });
					return;
				}
			}

			// Fallback: direct compile for unknown / not-indexed models
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
			lineageGraphProvider.setFocusModel(models[0].uniqueId);
			void vscode.commands.executeCommand('dbt-studio.lineageGraph.focus');
		}),

		vscode.commands.registerCommand('dbt-studio.toggleLineageFollow', () => {
			lineageGraphProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-studio.toggleLineageFollowOff', () => {
			lineageGraphProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-studio.showLineageTests', () => {
			lineageGraphProvider.setShowTests(true);
		}),

		vscode.commands.registerCommand('dbt-studio.hideLineageTests', () => {
			lineageGraphProvider.setShowTests(false);
		}),

		vscode.commands.registerCommand('dbt-studio.toggleLineageTests', () => {
			lineageGraphProvider.setShowTests(!lineageGraphProvider.showTests);
		}),

		vscode.commands.registerCommand('dbt-studio.refreshTestExplorer', () => {
			testExplorerProvider.refresh();
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
					testExplorerProvider.refresh();
				} catch {
					// Index rebuild may fail if manifest is still invalid
				}
				void vscode.window.showInformationMessage('dbt parse: success');
			} else {
				void vscode.window.showErrorMessage(`dbt parse: failed — ${result.stderr}`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.createModelFile', async (modelName: string) => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders) return;
			const modelsDir = vscode.Uri.joinPath(folders[0].uri, 'models');
			const fileUri = vscode.Uri.joinPath(modelsDir, `${modelName}.sql`);
			const content = new TextEncoder().encode(`-- ${modelName}\nselect\n    1 as id\n`);
			await vscode.workspace.fs.writeFile(fileUri, content);
			const doc = await vscode.workspace.openTextDocument(fileUri);
			await vscode.window.showTextDocument(doc);
		}),

		// ---- Test running commands (for explorer + CodeLens) ----

		vscode.commands.registerCommand('dbt-studio.runNamedModel', async (modelName: string) => {
			const result = await executionService.submit({
				type: 'run', args: ['run', '-s', modelName],
				priority: Priority.User, origin: 'user', label: `run ${modelName}`,
			});
			if (result.success) {
				void vscode.window.showInformationMessage(`dbt run ${modelName}: success`);
			} else {
				void vscode.window.showErrorMessage(`dbt run ${modelName}: failed — ${result.stderr}`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.testNamedModel', async (modelName: string) => {
			const result = await executionService.submit({
				type: 'test', args: ['test', '-s', modelName],
				priority: Priority.User, origin: 'user', label: `test ${modelName}`,
			});
			if (result.success) {
				void vscode.window.showInformationMessage(`dbt test ${modelName}: success`);
			} else {
				void vscode.window.showErrorMessage(`dbt test ${modelName}: failed — ${result.stderr}`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.runUnitTest', async (modelName: string, testName: string) => {
			const uid = testExplorerProvider.resolveUidByName(testName);
			if (uid) {
				await vsTestController.runTests([uid]);
			} else {
				// Fallback: test not yet indexed — run directly by selector
				const selector = modelName
					? `${modelName},test_type:unit,test_name:${testName}`
					: testName;
				testExplorerProvider.markRunningByName(testName);
				const result = await executionService.submit({
					type: 'test', args: ['test', '--select', selector, '--log-format', 'json'],
					priority: Priority.User, origin: 'user', label: `unit test ${testName}`,
				});
				testExplorerProvider.markResultByName(testName, result.success);
				if (result.success) {
					void vscode.window.showInformationMessage(`Unit test ${testName}: passed`);
				} else {
					void vscode.window.showErrorMessage(`Unit test ${testName}: failed — ${result.stderr}`);
				}
			}
		}),

		vscode.commands.registerCommand('dbt-studio.runCteTest', async (_yamlFilePath: string, testName: string) => {
			const uid = testExplorerProvider.resolveUidByName(testName);
			if (uid) {
				await vsTestController.runTests([uid]);
			} else {
				void vscode.window.showWarningMessage(`CTE test '${testName}' not found in tree — refresh the Test Explorer.`);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.runTestFromExplorer', async (item: unknown) => {
			const testItem = item as { uniqueId: string } | undefined;
			if (!testItem?.uniqueId) return;
			await vsTestController.runTests([testItem.uniqueId]);
		}),

		vscode.commands.registerCommand('dbt-studio.runTestGroupFromExplorer', async (item: unknown) => {
			const group = item as { children: Array<{ uniqueId: string }> } | undefined;
			if (!group?.children) return;
			await vsTestController.runTests(group.children.map(c => c.uniqueId));
		}),

		vscode.commands.registerCommand('dbt-studio.runTestCategoryFromExplorer', async (item: unknown) => {
			const category = item as { children: Array<{ children: Array<{ uniqueId: string }> }> } | undefined;
			if (!category?.children) return;
			const uids = category.children.flatMap(g => g.children).map(n => n.uniqueId);
			await vsTestController.runTests(uids);
		}),

		vscode.commands.registerCommand('dbt-studio.runAllTestsFromExplorer', async () => {
			await vsTestController.runTests();
		}),

		vscode.commands.registerCommand('dbt-studio.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nickeolofsson.dbt-studio-vscode');
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
