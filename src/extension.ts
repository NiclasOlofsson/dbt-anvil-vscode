import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { VSCodeLogger } from './types/logger';
import { ServiceContainer } from './types/service-container';
import { ManifestService } from './indexing/manifest-service';
import { detectPythonEnvironment, validatePythonEnvironment, dbtPackagesExist, checkEnvManagerAvailable, getBootstrapCommand, validateDbtInstalled } from './dbt/env-detector';
import { writeShims } from './dbt/terminal-env';
import { BridgeRunner } from './dbt/bridge-runner';
import { DbtExecutionService, Priority } from './dbt/execution-service';
import { CompileCache } from './dbt/compile-cache';
import { CompileCachePersistence } from './dbt/compile-cache-persistence';
import { DescribeCache } from './dbt/describe-cache';
import { DbtProjectService } from './dbt/dbt-project-service';
import { DbtPathResolver } from './dbt/dbt-path-resolver';
import { createDatabaseProvider } from './providers/database/database-provider-factory';
import { ColumnStorePersistence } from './indexing/column-store-persistence';
import { ContentHashPersistence } from './indexing/content-hash-persistence';
import { registerLanguageModelTools } from './tools';
import { GetColumnLineageTool } from './tools/get-column-lineage';
import { ModelExplorerProvider } from './views/model-explorer-provider';
import { LineageGraphProvider } from './views/lineage-graph-provider';
import { TestExplorerProvider } from './views/test-explorer-provider';
import { DbtDefinitionProvider } from './providers/sql/definition-provider';
import { DbtHoverProvider } from './providers/sql/hover-provider';
import { DbtCompletionProvider } from './providers/sql/completion-provider';
import { YamlCompletionProvider } from './providers/yaml/completion-provider';
import { YamlHoverProvider } from './providers/yaml/hover-provider';
import { DbtReferenceProvider } from './providers/sql/reference-provider';
import { DbtRenameProvider } from './providers/sql/rename-provider';
import { SqlCodeLensProvider } from './providers/sql/codelens-provider';
import { YamlCodeLensProvider } from './providers/yaml/codelens-provider';
import { SqlDocumentSymbolProvider } from './providers/sql/document-symbol-provider';
import { YamlDocumentSymbolProvider } from './providers/yaml/document-symbol-provider';
import { DbtWorkspaceSymbolProvider } from './providers/workspace-symbol-provider';
import { DbtSignatureHelpProvider } from './providers/sql/signature-help-provider';
import { SqlCodeActionProvider } from './providers/sql/code-action-provider';
import { NinjaFormattingProvider } from './providers/sql/formatting-provider';
import { ConfigCodeActionProvider } from './providers/common/config-code-action-provider';
import { DbtCallHierarchyProvider } from './providers/sql/call-hierarchy-provider';
import { ParseService } from './services/parse-service';
import { FtlDocumentParser } from './ftl/ftl-document-parser';
import { DbtQueryService } from './services/dbt-query-service';
import { StatusBarManager } from './views/status-bar';
import { ExternalDbtMonitor } from './dbt/external-dbt-monitor';
import { EditorDiagnosticsProvider } from './providers/editor-diagnostics-provider';
import { VsTestController } from './views/vs-test-controller';
import { CteTestRunner } from './dbt/cte-test-runner';
import { ModelProfiler } from './dbt/model-profiler';
import { ProfileResultPersistence } from './dbt/profile-result-persistence';
import { ProfilerDecorationProvider } from './providers/profiler-decoration-provider';
import { QueryDecorationProvider } from './providers/query-decoration-provider';
import { ProfilerResultsProvider } from './views/profiler-results-provider';
import { QueryRunner, type StatementResult } from './dbt/query-runner';
import { QueryResultPanel } from './views/query-result-panel';
import { SqlDebugAdapter } from './dbt/debug-adapter';
import { SqlDebugConfigProvider } from './dbt/debug-config-provider';
import { DataPipelineProvider } from './dbt/debug-pipeline-provider';
import { SymbolSqlProvider } from './providers/symbol-sql-provider';
import { splitStatements } from './dbt/statement-splitter';
import { WorkspaceDiagnosticsScanner } from './ninja/workspace-diagnostics-scanner';
import { NinjaEditorPanel } from './ninja/editor';
import * as path from 'node:path';

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

	// -------- Claim .sql files as jinja-sql --------
	// Other extensions (sqlfluff, sql-formatter, etc.) may steal .sql bindings depending
	// on load order. Since we only activate inside dbt projects, we forcibly reassign
	// any .sql document that another extension has already claimed.
	const claimSqlDocument = (document: vscode.TextDocument) => {
		if (document.fileName.endsWith('.sql') && document.languageId !== 'jinja-sql') {
			void vscode.languages.setTextDocumentLanguage(document, 'jinja-sql');
		}
	};
	vscode.workspace.textDocuments.forEach(claimSqlDocument);
	context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(claimSqlDocument));

	// -------- Resolve workspace/project directory --------
	const workspaceFolders = vscode.workspace.workspaceFolders;
	if (!workspaceFolders || workspaceFolders.length === 0) {
		logger.warn('No workspace folder open — dbt Studio may be limited.');
		return;
	}

	const projectDir = workspaceFolders[0].uri.fsPath;
	const storageDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
	const extensionTargetDir = path.join(storageDir, 'target');
	const projectService = new DbtProjectService(projectDir, logger);
	context.subscriptions.push({ dispose: () => projectService.dispose() });
	projectService.startWatching();
	const hasDbtProject = !!projectService.projectConfig;

	// -------- Detect Python environment --------
	const pythonEnv = detectPythonEnvironment(projectDir);
	logger.info(`Python environment: ${pythonEnv.description} (${pythonEnv.command.join(' ')})`);

	let initError: string | null = null;
	let envReady = await validatePythonEnvironment(pythonEnv);

	if (!envReady) {
		// Check whether the env manager (pipenv/uv/poetry) is even installed.
		const managerAvailable = await checkEnvManagerAvailable(pythonEnv);
		if (!managerAvailable) {
			const mgr = pythonEnv.description.split(' ')[0]; // e.g. 'pipenv'
			logger.warn(`Environment manager not found on PATH: ${mgr}`);
			initError = `${mgr} is not installed or not on PATH. Install it (e.g. pip install ${mgr}), then reload the window.`;
			void vscode.window.showErrorMessage(
				`dbt Studio: ${mgr} is not installed or not on PATH. Install it, then reload the window.`,
				'Reload Window',
			).then((selection) => {
				if (selection === 'Reload Window') {
					void vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			});
		} else {
			// Manager is available — try to bootstrap the environment from the lockfile.
			const bootstrapCmd = getBootstrapCommand(pythonEnv, projectDir);
			if (bootstrapCmd) {
				logger.info(`Bootstrapping Python environment: ${bootstrapCmd.join(' ')}`);
				envReady = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'dbt Studio: Setting up Python environment…', cancellable: false },
					() => _runBootstrap(bootstrapCmd, projectDir, pythonEnv.envVars),
				);
				if (envReady) {
					envReady = await validatePythonEnvironment(pythonEnv);
				}
				if (!envReady) {
					logger.warn(`Bootstrap completed but Python environment still not working: ${pythonEnv.description}`);
					initError = `Python environment setup failed (${pythonEnv.description}). Check the dbt Studio output channel for details.`;
					void vscode.window.showErrorMessage(
						'dbt Studio: Python environment setup failed. See the dbt Studio output channel for details.',
						'Show Output',
					).then((selection) => {
						if (selection === 'Show Output') {
							void vscode.commands.executeCommand('dbt-studio.showOutputChannel');
						}
					});
				} else {
					logger.info('Python environment bootstrap succeeded.');
				}
			} else {
				logger.warn(`Python environment validation failed: ${pythonEnv.description}`);
				initError = `Python environment not working (${pythonEnv.description}). dbt features are disabled.`;
				void vscode.window.showWarningMessage(
					`dbt Studio: Python environment not found or not working (${pythonEnv.description}). dbt features are disabled.`,
					'Reload Window',
				).then((selection) => {
					if (selection === 'Reload Window') {
						void vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
		}
	}

	if (envReady && !initError) {
		const dbtInstalled = await validateDbtInstalled(pythonEnv, projectDir);
		if (!dbtInstalled) {
			logger.warn(`dbt not found in Python environment: ${pythonEnv.description}`);
			// dbt missing but env manager is available — try bootstrapping first.
			const bootstrapCmd = getBootstrapCommand(pythonEnv, projectDir);
			if (bootstrapCmd) {
				logger.info(`dbt missing — bootstrapping environment: ${bootstrapCmd.join(' ')}`);
				const bootstrapOk = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: 'dbt Studio: Installing project dependencies…', cancellable: false },
					() => _runBootstrap(bootstrapCmd, projectDir, pythonEnv.envVars),
				);
				if (bootstrapOk && await validateDbtInstalled(pythonEnv, projectDir)) {
					logger.info('Bootstrap succeeded — dbt is now available.');
				} else {
					logger.warn(`dbt still not found after bootstrap: ${pythonEnv.description}`);
					initError = `dbt is not installed in the Python environment (${pythonEnv.description}). Add dbt to your project dependencies and reload.`;
					void vscode.window.showErrorMessage(
						'dbt Studio: dbt is not installed in the Python environment. Add it to your project dependencies and reload the window.',
						'Reload Window',
					).then((selection) => {
						if (selection === 'Reload Window') {
							void vscode.commands.executeCommand('workbench.action.reloadWindow');
						}
					});
				}
			} else {
				initError = `dbt is not installed in the Python environment (${pythonEnv.description}). Add dbt to your project dependencies and reload.`;
				void vscode.window.showErrorMessage(
					'dbt Studio: dbt is not installed in the Python environment. Add it to your project dependencies and reload the window.',
					'Reload Window',
				).then((selection) => {
					if (selection === 'Reload Window') {
						void vscode.commands.executeCommand('workbench.action.reloadWindow');
					}
				});
			}
		}
	}

	// -------- Terminal environment setup --------
	const contributeCliShim = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('terminal.contributeCliShim', true);
	if (contributeCliShim && envReady) {
		try {
			const shimsDir = path.join(storageDir, 'shims');
			logger.info(`Creating terminal shims at: ${shimsDir}`);
			const shimPath = writeShims(shimsDir, pythonEnv);
			if (shimPath) {
				context.environmentVariableCollection.clear();
				context.environmentVariableCollection.prepend('PATH', shimPath + path.delimiter);
				context.environmentVariableCollection.description = `dbt Studio: activated ${pythonEnv.description}`;
				logger.info(`Terminal shim contributed: ${shimPath}`);
			} else {
				logger.info('No terminal shim needed (system Python)');
			}
		} catch (error) {
			logger.error(`Failed to create terminal shims: ${error}`);
		}
	} else if (!contributeCliShim) {
		// Clear any existing PATH modifications if the setting is disabled
		context.environmentVariableCollection.clear();
	}

	// -------- Set up manifest loading and indexing --------
	const manifestService = new ManifestService(projectService, extensionTargetDir, logger);
	const manifestLoader = manifestService.loader;
	const manifestIndexer = manifestService.indexer;

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
	// Restore content hashes before start() so the first save after a restart
	// does not falsely trigger a dbt parse for files that haven't changed.
	const contentHashPersistence = new ContentHashPersistence(context, logger);
	manifestService.restoreHashes(contentHashPersistence.restore());
	manifestService.start();
	container.setManifestWatcher(manifestService);
	context.subscriptions.push({ dispose: () => manifestService.dispose() });
	context.subscriptions.push({ dispose: () => { const { hashes, nonWsHashes } = manifestService.getHashes(); contentHashPersistence.save(hashes, nonWsHashes); } });
	context.subscriptions.push({ dispose: () => columnStorePersistence.save(manifestIndexer) });
	const manifestWatcher = manifestService;

	// -------- Python bridge --------
	// Single persistent bridge process for dbt commands and inline compilation.
	const bridgePyPath = vscode.Uri.joinPath(context.extensionUri, 'resources', 'bridge', 'bridge.py').fsPath;
	const stateDir = storageDir;
	const dbtBridgeRunner = new BridgeRunner(bridgePyPath, projectDir, pythonEnv, logger, stateDir, extensionTargetDir);
	container.setBridgeRunner(dbtBridgeRunner);
	context.subscriptions.push({ dispose: () => void dbtBridgeRunner.shutdown() });

	// -------- Execution service (priority queue around dbt bridge) --------
	const executionService = new DbtExecutionService(dbtBridgeRunner, manifestLoader, manifestWatcher, logger);
	container.setExecutionService(executionService);
	context.subscriptions.push({ dispose: () => executionService.dispose() });

	// Connect manifest watcher to execution service for background parse-on-save
	context.subscriptions.push(
		manifestWatcher.onParseRequested(() => {
			void executionService.submit({
				type: 'parse',
				args: ['parse'],
				priority: Priority.Background,
				origin: 'background',
				label: 'parse (on save)',
			}).catch(() => { /* superseded or cancelled */ });
		}),
	);

	// -------- dbt deps check --------
	if (envReady && !initError && hasDbtProject && !dbtPackagesExist(projectDir)) {
		void vscode.window.showWarningMessage(
			'dbt packages not installed. Run dbt deps to set up your project.',
			'Run dbt deps',
		).then((selection) => {
			if (selection === 'Run dbt deps') {
				void executionService.submit({
					type: 'deps', args: ['deps'],
					priority: Priority.User, origin: 'user', label: 'install deps',
				}).then((result) => {
					if (result.success) {
						void vscode.window.showInformationMessage('dbt deps: success');
					} else {
						void vscode.window.showErrorMessage(`dbt deps: failed — ${result.stderr}`);
					}
				});
			}
		});
	}

	// -------- Compile cache (shared across all tools) --------
	const compileCache = new CompileCache(executionService, manifestLoader, logger);
	const compileCachePersistence = new CompileCachePersistence(context, logger);
	const restoredCompileEntries = compileCachePersistence.restore(compileCache, projectDir);
	context.subscriptions.push({ dispose: () => compileCachePersistence.save(compileCache) });

	// -------- Describe cache (shared across providers and tools) --------
	const describeCache = new DescribeCache(executionService, manifestIndexer, logger);
	context.subscriptions.push(describeCache.onDescribeError(() => {
		void vscode.window.showWarningMessage(
			'Could not describe some tables — seed data may not be loaded yet. Run dbt seed to load your seed files.',
			'Run dbt seed',
		).then((selection) => {
			if (selection === 'Run dbt seed') {
				void executionService.submit({
					type: 'seed', args: ['seed'],
					priority: Priority.User, origin: 'user', label: 'seed',
				}).then((result) => {
					if (result.success) {
						void vscode.window.showInformationMessage('dbt seed: success');
					} else {
						void vscode.window.showErrorMessage(`dbt seed: failed — ${result.stderr}`);
					}
				});
			}
		});
	}));

	// -------- Database provider (direct warehouse access, bypasses dbt bridge queue) --------
	logger.info('Resolved dbt/extension paths:');
	logger.info(`  projectDir: ${projectDir}`);
	logger.info(`  storageDir: ${storageDir}`);
	logger.info(`  extensionTargetDir: ${extensionTargetDir}`);
	logger.info(`  extensionManifestPath: ${manifestLoader.manifestPath}`);
	logger.info(`  stateDir: ${stateDir}`);
	logger.info(`  projectTargetDir (dbt_project.yml): ${projectService.targetPath}`);
	logger.info(`  profilesDir: ${projectService.profilesDir}`);
	logger.info(`  modelPaths: ${projectService.modelPaths.join(', ')}`);
	logger.info(`  seedPaths: ${projectService.seedPaths.join(', ')}`);
	logger.info(`  macroPaths: ${projectService.macroPaths.join(', ')}`);
	logger.info(`  analysisPaths: ${projectService.analysisPaths.join(', ')}`);
	logger.info(`  snapshotPaths: ${projectService.snapshotPaths.join(', ')}`);
	logger.info(`  testPaths: ${projectService.testPaths.join(', ')}`);
	const databaseProvider = await createDatabaseProvider(projectService.activeConnection, projectDir, executionService, logger);
	container.setDatabaseProvider(databaseProvider);
	describeCache.setProvider(databaseProvider);

	// -------- Status bar --------
	const statusBar = new StatusBarManager(executionService, logger);
	// If the manifest was already indexed on startup, we're ready immediately.
	// Otherwise the status bar stays in "Initializing" until onIndexRebuild fires.
	let startupReady = manifestLoader.manifestExists();
	if (manifestLoader.manifestExists()) {
		statusBar.setReady();
	}
	if (initError) {
		statusBar.setError(initError);
	}
	context.subscriptions.push(statusBar);

	// -------- External dbt monitor (detect conflicting terminal dbt commands) --------
	if (vscode.workspace.getConfiguration('dbt-studio').get<boolean>('terminal.externalCommandMonitor.enabled', true)) {
		const externalDbtMonitor = new ExternalDbtMonitor(projectDir, executionService, manifestWatcher, logger, context);
		externalDbtMonitor.start();
		context.subscriptions.push(externalDbtMonitor);
	} else {
		logger.warn('ExternalDbtMonitor is disabled via dbt-studio.terminal.externalCommandMonitor.enabled — concurrent terminal dbt commands may corrupt the manifest.');
	}

	// Kick off a full compile to warm the cache. Skipped if enough valid entries
	// were restored from disk (mtime validation happens on first access per entry).
	void compileCache.warmAll(projectDir, restoredCompileEntries);

	// -------- Parse service (FTL — Pyodide worker pool, true CPU parallelism) --------
	const pyodideDir = path.join(context.extensionPath, 'node_modules', 'pyodide');
	const vendorDir = path.join(context.extensionPath, 'resources', 'ftl', 'vendor');
	const scriptsDir = path.join(context.extensionPath, 'resources', 'ftl');
	const ftlParser = FtlDocumentParser.create(pyodideDir, vendorDir, scriptsDir, manifestIndexer, { logger });
	await ftlParser.ready();
	logger.info('Parse service: FTL worker pool ready');
	const parseService = new ParseService(ftlParser, logger, { describeCache, indexer: manifestIndexer });
	context.subscriptions.push(ftlParser);

	context.subscriptions.push(
		manifestWatcher.onEnrichmentInvalidated((evicted) => {
			parseService.invalidateEnrichmentFor(evicted);
		}),
		manifestWatcher.onCompileInvalidated((uid) => {
			compileCache.invalidate(uid);
		}),
	);

	// -------- Model profiler --------
	const dbtQueryService = new DbtQueryService(compileCache, parseService, manifestIndexer);
	const modelProfiler = new ModelProfiler(dbtQueryService, databaseProvider, manifestIndexer, logger);
	const profileResultPersistence = new ProfileResultPersistence(context, logger);
	modelProfiler.initPersistence(profileResultPersistence);
	container.setModelProfiler(modelProfiler);
	context.subscriptions.push(modelProfiler);

	// -------- Diagnostics provider --------
	const diagnosticsProvider = new EditorDiagnosticsProvider(executionService, manifestIndexer, statusBar, projectDir, logger, parseService, parseService.onAliasesReady, manifestWatcher.onIndexRebuild, parseService.onSqlglotWarnings, startupReady);
	context.subscriptions.push(diagnosticsProvider);

	// -------- Set workspaceHasDBT context --------
	// This context means "dbt project is present", not "manifest already exists".
	// Cold start must still show the extension UI/actions before the first parse/compile
	// creates the manifest in the extension target folder.
	void vscode.commands.executeCommand('setContext', 'workspaceHasDBT', hasDbtProject);

	// -------- Register Copilot language model tools --------
	registerLanguageModelTools(context, manifestIndexer, executionService, manifestLoader, logger, compileCache, databaseProvider, describeCache, dbtQueryService, ftlParser);

	// -------- Register tree views --------
	const modelExplorerProvider = new ModelExplorerProvider(manifestIndexer, logger, projectDir, context.globalState);
	const lineageGraphProvider = new LineageGraphProvider(manifestIndexer, logger, context.globalState);
	const columnLineageTool = new GetColumnLineageTool(manifestIndexer, logger, compileCache, describeCache, ftlParser);
	lineageGraphProvider.setColumnLineageTool(columnLineageTool);
	lineageGraphProvider.setExecutionService(executionService);
	// Initialise context keys so the correct toolbar icons show from the start
	void vscode.commands.executeCommand('setContext', 'dbt-studio.lineageFollowActive', lineageGraphProvider.followActive);
	void vscode.commands.executeCommand('setContext', 'dbt-studio.lineage.showTests', lineageGraphProvider.showTests);
	void vscode.commands.executeCommand('setContext', 'dbt-studio.explorerFollowActive', modelExplorerProvider.followActive);
	void vscode.commands.executeCommand('setContext', ProfilerDecorationProvider.contextKey, true);
	const testExplorerProvider = new TestExplorerProvider(manifestIndexer, manifestLoader, logger);

	const modelExplorerView = vscode.window.createTreeView('dbt-studio.modelExplorer', {
		treeDataProvider: modelExplorerProvider,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		modelExplorerView,
		vscode.window.registerWebviewViewProvider(LineageGraphProvider.viewId, lineageGraphProvider),
		vscode.window.registerTreeDataProvider('dbt-studio.testExplorer', testExplorerProvider),
	);

	// -------- Profiler views --------
	const profilerResultsProvider = new ProfilerResultsProvider(modelProfiler);
	const profilerDecorationProvider = new ProfilerDecorationProvider(modelProfiler, parseService, manifestIndexer);
	context.subscriptions.push(
		profilerResultsProvider,
		profilerDecorationProvider,
		vscode.window.registerTreeDataProvider(ProfilerResultsProvider.viewId, profilerResultsProvider),
	);

	// -------- Native VS Code Testing panel --------
	const cteTestRunner = new CteTestRunner(projectDir, executionService);
	const vsTestController = new VsTestController(testExplorerProvider, executionService, logger, cteTestRunner);
	context.subscriptions.push(vsTestController);

	// Refresh views whenever the manifest index is rebuilt (e.g. after dbt parse on save).
	// Also evict cache entries that were parsed before the manifest was available so the
	// diagnostics-provider's next re-validate call triggers a fresh enriched parse.
	context.subscriptions.push(
		manifestWatcher.onIndexRebuild(() => {
			if (!startupReady) {
				startupReady = true;
				diagnosticsProvider.setStartupReady();
			}
			parseService.evictUnenrichedDocuments();
			statusBar.setReady();
			testExplorerProvider.refresh();
			lineageGraphProvider.refreshGraph();
			columnStorePersistence.save(manifestIndexer);
			void dbtBridgeRunner.invalidateManifestCache();
		}),
	);

	if (!manifestLoader.manifestExists()) {
		void (async () => {
			logger.info('No manifest in extension target on startup — triggering background dbt parse');
			try {
				const result = await executionService.submit({
					type: 'parse',
					args: ['parse'],
					priority: Priority.Background,
					origin: 'background',
					label: 'parse (startup bootstrap)',
				});
				if (!result.success) {
					const msg = `Startup parse failed: ${result.stderr}`;
					logger.warn(msg);
					statusBar.setError(msg);
					return;
				}
				try {
					manifestIndexer.build(true);
					if (!startupReady) {
						startupReady = true;
						diagnosticsProvider.setStartupReady();
					}
					statusBar.setReady();
					const refreshedProvider = await createDatabaseProvider(projectService.activeConnection, projectDir, executionService, logger);
					container.setDatabaseProvider(refreshedProvider);
					describeCache.setProvider(refreshedProvider);
					modelProfiler.setProvider(refreshedProvider);
					testExplorerProvider.refresh();
					modelExplorerProvider.refresh();
					lineageGraphProvider.refreshGraph();
					columnStorePersistence.save(manifestIndexer);
					logger.info('Startup parse completed and manifest index rebuilt');
				} catch (err) {
					const msg = `Startup parse succeeded but manifest rebuild failed: ${err}`;
					logger.warn(msg);
					statusBar.setError(msg);
				}
			} catch (err) {
				const msg = `Startup parse error: ${err}`;
				logger.warn(msg);
				statusBar.setError(msg);
			}
		})();
	}

	// -------- Editor follow (sync explorer + lineage) --------
	const revealModelForEditor = (editor: vscode.TextEditor | undefined) => {
		if (!editor) return;
		const uid = manifestIndexer.findModelByFilePath(editor.document.fileName);
		if (!uid) return;

		const item = modelExplorerProvider.findModelItemForReveal(uid);
		if (item && modelExplorerView.visible && modelExplorerProvider.followActive) {
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

	// -------- Path resolver (file classification from dbt_project.yml) --------
	const pathResolver = new DbtPathResolver(projectDir);
	pathResolver.refresh(projectService.projectConfig);

	// -------- File-category context key (drives menu visibility) --------
	const updateFileCategory = (editor: vscode.TextEditor | undefined) => {
		const category = editor?.document.languageId === 'jinja-sql'
			? pathResolver.classifyFile(editor.document.fileName)
			: undefined;
		void vscode.commands.executeCommand('setContext', 'dbt-studio.fileCategory', category);
	};
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateFileCategory));
	updateFileCategory(vscode.window.activeTextEditor);

	// -------- Register language providers (dynamic, re-registered on path changes) --------
	const definitionProvider = new DbtDefinitionProvider(manifestIndexer, manifestLoader, logger, parseService);
	const hoverProvider = new DbtHoverProvider(manifestIndexer, logger, parseService);
	const completionProvider = new DbtCompletionProvider(manifestIndexer, logger, parseService);
	const yamlCompletionProvider = new YamlCompletionProvider(manifestIndexer, logger);
	const yamlHoverProvider = new YamlHoverProvider(manifestIndexer, logger);
	const referenceProvider = new DbtReferenceProvider(manifestIndexer, logger, parseService);
	const renameProvider = new DbtRenameProvider(manifestIndexer, manifestLoader, logger, parseService);
	const sqlCodeLensProvider = new SqlCodeLensProvider(manifestIndexer, logger, parseService);
	sqlCodeLensProvider.setPathResolver(pathResolver);
	const yamlCodeLensProvider = new YamlCodeLensProvider(manifestIndexer, logger);
	const sqlDocumentSymbolProvider = new SqlDocumentSymbolProvider(manifestIndexer, logger, parseService);
	const yamlDocumentSymbolProvider = new YamlDocumentSymbolProvider(logger);
	const workspaceSymbolProvider = new DbtWorkspaceSymbolProvider(manifestIndexer, logger);
	const signatureHelpProvider = new DbtSignatureHelpProvider(manifestIndexer, logger);
	const sqlCodeActionProvider = new SqlCodeActionProvider(manifestIndexer, logger);
	sqlCodeActionProvider.setPathResolver(pathResolver);
	sqlCodeActionProvider.setNinjaResultProvider(uri => diagnosticsProvider.getNinjaResult(uri));
	const ninjaFormattingProvider = new NinjaFormattingProvider(parseService, manifestIndexer);
	const configCodeActionProvider = new ConfigCodeActionProvider();
	const callHierarchyProvider = new DbtCallHierarchyProvider(manifestIndexer, logger, parseService);

	let providerDisposables: vscode.Disposable[] = [];

	const registerProviders = (): void => {
		// Dispose previous registrations
		for (const d of providerDisposables) d.dispose();

		const sqlSelector: vscode.DocumentSelector = pathResolver.buildSqlSelector();
		const yamlSelector: vscode.DocumentSelector = pathResolver.buildYamlSelector();

		providerDisposables = [
			vscode.languages.registerDefinitionProvider(sqlSelector, definitionProvider),
			vscode.languages.registerHoverProvider(sqlSelector, hoverProvider),
			vscode.languages.registerCompletionItemProvider(sqlSelector, completionProvider, '\'', '"', '.'),
			vscode.languages.registerCompletionItemProvider(yamlSelector, yamlCompletionProvider),
			vscode.languages.registerHoverProvider(yamlSelector, yamlHoverProvider),
			vscode.languages.registerReferenceProvider(sqlSelector, referenceProvider),
			vscode.languages.registerRenameProvider(sqlSelector, renameProvider),
			vscode.languages.registerCodeLensProvider(sqlSelector, sqlCodeLensProvider),
			vscode.languages.registerCodeLensProvider(yamlSelector, yamlCodeLensProvider),
			vscode.languages.registerDocumentSymbolProvider(sqlSelector, sqlDocumentSymbolProvider),
			vscode.languages.registerDocumentSymbolProvider(yamlSelector, yamlDocumentSymbolProvider),
			vscode.languages.registerWorkspaceSymbolProvider(workspaceSymbolProvider),
			vscode.languages.registerSignatureHelpProvider(sqlSelector, signatureHelpProvider, '(', ','),
			vscode.languages.registerCodeActionsProvider(sqlSelector, sqlCodeActionProvider, {
				providedCodeActionKinds: SqlCodeActionProvider.providedCodeActionKinds,
			}),
			vscode.languages.registerCodeActionsProvider({ pattern: '**/dbt_project.yml' }, configCodeActionProvider, {
				providedCodeActionKinds: ConfigCodeActionProvider.providedCodeActionKinds,
			}),
			vscode.languages.registerCallHierarchyProvider(sqlSelector, callHierarchyProvider),
			vscode.languages.registerDocumentFormattingEditProvider(sqlSelector, ninjaFormattingProvider),
		];

		logger.info(`Registered language providers with ${sqlSelector.length} SQL filters, ${yamlSelector.length} YAML filters`);
	};

	registerProviders();

	// Re-register providers when dbt_project.yml paths change
	context.subscriptions.push(
		manifestWatcher.onProjectConfigChanged(() => {
			pathResolver.refresh(manifestLoader.projectConfig);
		}),
		pathResolver.onPathsChanged(() => {
			logger.info('dbt project paths changed — re-registering language providers');
			registerProviders();
		}),
		{ dispose: () => { for (const d of providerDisposables) d.dispose(); } },
	);

	const requireEnv = (): boolean => {
		if (!envReady) {
			void vscode.window.showWarningMessage(
				`Python environment is not working (${pythonEnv.description}). Please fix your setup and reload the window.`,
				'Reload Window',
			).then((selection) => {
				if (selection === 'Reload Window') {
					void vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			});
			return false;
		}
		return true;
	};

	// -------- Register commands --------
	context.subscriptions.push(
		vscode.commands.registerCommand('dbt-studio.showOutputChannel', () => {
			outputChannel.show(true);
		}),
		vscode.commands.registerCommand('dbt-studio.suppressSqlFluffWarning', async () => {
			await vscode.workspace.getConfiguration('dbt-studio').update('notifications.suppressSqlFluffWarning', true, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('dbt-studio.suppressAutoSaveWarning', async () => {
			await vscode.workspace.getConfiguration('dbt-studio').update('notifications.suppressAutoSaveWarning', true, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('dbt-studio.setAsDefaultFormatter', async () => {
			await vscode.workspace.getConfiguration('editor', { languageId: 'jinja-sql' }).update('defaultFormatter', 'nickeolofsson.dbt-studio-vscode', vscode.ConfigurationTarget.Global, true);
		}),
		vscode.commands.registerCommand('dbt-studio.suppressFormatterWarning', async () => {
			await vscode.workspace.getConfiguration('dbt-studio').update('notifications.suppressFormatterWarning', true, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('dbt-studio.ninja.scanWorkspace', () => { void workspaceScanner?.scanAll(); }),
		vscode.commands.registerCommand('dbt-studio.ninja.openRuleEditor', () => {
			const panel = NinjaEditorPanel.getInstance();
			panel.setScanner(workspaceScanner);
			void panel.open();
		}),
		vscode.commands.registerCommand('dbt-studio.ninja.statusBarMenu', async () => {
			const items: vscode.QuickPickItem[] = [
				{ label: '$(search) Rescan all files', description: 'Run Ninja on every SQL file in the workspace' },
				{ label: '$(edit) Rule Editor', description: 'Open the Ninja Rule Editor' },
				{ label: '$(warning) Open Problems panel', description: 'Show all Ninja diagnostics' },
				{ label: '$(gear) Open Ninja settings', description: 'Configure dbt-studio.ninja options' },
				{ label: '$(trash) Clear Ninja diagnostics', description: 'Remove all Ninja issues from the Problems panel' },
			];
			const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Ninja workspace diagnostics' });
			if (!pick) return;
			if (pick.label.includes('Rescan')) {
				void workspaceScanner?.scanAll();
			} else if (pick.label.includes('Rule Editor')) {
				void vscode.commands.executeCommand('dbt-studio.ninja.openRuleEditor');
			} else if (pick.label.includes('Open Problems')) {
				void vscode.commands.executeCommand('workbench.action.problems.focus');
			} else if (pick.label.includes('settings')) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'dbt-studio.ninja');
			} else if (pick.label.includes('Clear')) {
				workspaceScanner?.clear();
			}
		}),
		vscode.commands.registerCommand('dbt-studio.statusBarMenu', async () => {
			const items: vscode.QuickPickItem[] = [
				{ label: '$(trash) Clear All Caches', description: 'Hard reset — wipes all cached data from memory and disk' },
				{ label: '$(gear) Open Settings', description: 'Configure dbt Studio options' },
				{ label: '$(output) Show Output Channel', description: 'Open the dbt Studio output log' },
			];
			const pick = await vscode.window.showQuickPick(items, { placeHolder: 'dbt Studio' });
			if (!pick) return;
			if (pick.label.includes('Clear All')) {
				// Clear in-memory caches
				compileCache.clearAll();
				manifestIndexer.clearColumnStore();
				describeCache.resetError();
				modelProfiler.clearAll();
				// Delete only the specific files we write to storage
				const storageDir = context.storageUri?.fsPath;
				if (storageDir) {
					for (const file of ['compile-cache.json', 'column-store.json', 'content-hashes.json', 'profile-results.json', 'ninja-scan-hashes.json']) {
						try { fs.unlinkSync(`${storageDir}/${file}`); } catch { /* ignore if absent */ }
					}
				}
				void vscode.window.showInformationMessage('All caches cleared.');
			} else if (pick.label.includes('Settings')) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'dbt-studio');
			} else if (pick.label.includes('Output')) {
				void vscode.commands.executeCommand('dbt-studio.showOutputChannel');
			}
		}),
		vscode.commands.registerCommand('dbt-studio.goToLine', async (args: { uri: string; line: number }) => {
			const uri = vscode.Uri.parse(args.uri);
			const pos = new vscode.Position(args.line, 0);
			await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preserveFocus: false });
		}),

		vscode.commands.registerCommand('dbt-studio.refreshExplorer', () => {
			modelExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-studio.runModel', async () => {
			if (!requireEnv()) return;
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
			if (!requireEnv()) return;
			const model = getActiveModelName();
			if (!model) return;
			await vsTestController.runTestsForModel(model);
		}),

		vscode.commands.registerCommand('dbt-studio.buildModel', async () => {
			if (!requireEnv()) return;
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
			if (!requireEnv()) return;
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
			void (async () => {
				const model = getActiveModelName();
				if (!model) return;
				const models = manifestIndexer.findModelsByName(model);
				if (models.length === 0) {
					void vscode.window.showWarningMessage(`Model "${model}" not found in manifest yet. The startup parse may still be running.`);
					return;
				}
				lineageGraphProvider.setFocusModel(models[0].uniqueId);
				void vscode.commands.executeCommand('dbt-studio.lineageGraph.focus');
			})();
		}),

		vscode.commands.registerCommand('dbt-studio.toggleLineageFollow', () => {
			lineageGraphProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-studio.toggleLineageFollowOff', () => {
			lineageGraphProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-studio.toggleExplorerFollow', () => {
			modelExplorerProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-studio.toggleExplorerFollowOff', () => {
			modelExplorerProvider.toggleFollow();
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
			if (!requireEnv()) return;
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
			if (!requireEnv()) return;
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

		vscode.commands.registerCommand('dbt-studio.inlineRefs', async (uri: vscode.Uri) => {
			const doc = await vscode.workspace.openTextDocument(uri);
			const inlined = sqlCodeActionProvider.inlineRefs(doc.getText());
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), inlined);
			await vscode.workspace.applyEdit(edit);
		}),

		vscode.commands.registerCommand('dbt-studio.restoreRefs', async (uri: vscode.Uri) => {
			const doc = await vscode.workspace.openTextDocument(uri);
			const restored = sqlCodeActionProvider.restoreRefs(doc.getText());
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), restored);
			await vscode.workspace.applyEdit(edit);
		}),

		// ---- Test running commands (for explorer + CodeLens) ----

		vscode.commands.registerCommand('dbt-studio.runNamedModel', async (modelName: string) => {
			if (!requireEnv()) return;
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
			if (!requireEnv()) return;
			await vsTestController.runTestsForModel(modelName);
		}),

		vscode.commands.registerCommand('dbt-studio.runUnitTest', async (_modelName: string, testName: string) => {
			const uid = testExplorerProvider.resolveUidByName(testName);
			if (uid) {
				await vsTestController.runTests([uid]);
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

		// ---- Profiler commands ----

		vscode.commands.registerCommand('dbt-studio.profiler.profileModel', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'jinja-sql') {
				void vscode.window.showWarningMessage('Open a dbt SQL model file to profile it.');
				return;
			}
			void vscode.commands.executeCommand('setContext', 'dbt-studio.profilingActive', true);
			try {
				await modelProfiler.profileDocument(editor.document);
			} catch (err) {
				void vscode.window.showErrorMessage(`Profile failed: ${err}`);
			} finally {
				void vscode.commands.executeCommand('setContext', 'dbt-studio.profilingActive', false);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.profiler.clearResults', () => {
			modelProfiler.clearAll();
		}),

		vscode.commands.registerCommand('dbt-studio.profiler.cancelProfiling', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const result = modelProfiler.getResultForFile(editor.document.fileName);
			if (result?.status === 'running') {
				modelProfiler.cancelProfiling(result.modelId);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.profiler.goToCte', async (filePath: string, cteName: string) => {
			const doc = await vscode.workspace.openTextDocument(filePath);
			const model = await parseService.getDocumentModel(doc, { skipEnrichment: true });
			let line: number;
			if (cteName === '_main_') {
				// Navigate to the final SELECT
				line = model?.finalSelect?.line ?? model?.finalColumns[0]?.line ?? 0;
			} else {
				line = model?.ctes.find(c => c.name === cteName)?.line ?? 0;
			}
			const pos = new vscode.Position(line, 0);
			await vscode.window.showTextDocument(doc, {
				selection: new vscode.Range(pos, pos),
				preserveFocus: false,
			});
		}),

		vscode.commands.registerCommand('dbt-studio.profiler.showDecorations', () => {
			if (!profilerDecorationProvider.visible) {
				profilerDecorationProvider.toggle();
			}
			void vscode.commands.executeCommand('setContext', ProfilerDecorationProvider.contextKey, true);
		}),

		vscode.commands.registerCommand('dbt-studio.profiler.hideDecorations', () => {
			if (profilerDecorationProvider.visible) {
				profilerDecorationProvider.toggle();
			}
			void vscode.commands.executeCommand('setContext', ProfilerDecorationProvider.contextKey, false);
		}),
	);

	// -------- Query runner (ad-hoc SQL execution) --------
	const queryResultPanel = QueryResultPanel.getInstance(context.extensionUri, context.workspaceState);
	context.subscriptions.push(
		vscode.window.registerWebviewPanelSerializer(QueryResultPanel.viewType, queryResultPanel),
		vscode.window.registerWebviewViewProvider(QueryResultPanel.viewId, queryResultPanel),
	);
	const queryRunner = new QueryRunner(databaseProvider, (results, resultLocation) => {
		queryResultPanel.showResults(results, resultLocation);
	});
	context.subscriptions.push(new QueryDecorationProvider(queryRunner));
	sqlCodeLensProvider.setQueryRunner(queryRunner);

	context.subscriptions.push(
		vscode.commands.registerCommand('dbt-studio.executeQuery', async () => {
			if (!requireEnv()) return;
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'jinja-sql') {
				void vscode.window.showWarningMessage('Open a dbt SQL file to execute queries.');
				return;
			}
			const category = pathResolver.classifyFile(editor.document.fileName);
			if (category === 'model' || category === 'snapshot' || category === 'seed') {
				void vscode.window.showInformationMessage('Use the Run / Compile CodeLens to execute model files.');
				return;
			}
			await vscode.debug.startDebugging(undefined, { type: 'dbt-sql', request: 'launch', name: 'Run SQL', scope: 'cursor' });
		}),

		vscode.commands.registerCommand('dbt-studio.executeAll', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'jinja-sql') {
				void vscode.window.showWarningMessage('Open a dbt SQL file to execute queries.');
				return;
			}
			const category = pathResolver.classifyFile(editor.document.fileName);
			if (category === 'model' || category === 'snapshot' || category === 'seed') {
				void vscode.window.showInformationMessage('Use the Run / Compile CodeLens to execute model files.');
				return;
			}
			const stmts = splitStatements(editor.document.getText());
			if (stmts.length <= 1) {
				await vscode.debug.startDebugging(undefined, { type: 'dbt-sql', request: 'launch', name: 'Run All SQL', scope: 'all' });
			} else {
				await Promise.all(stmts.map(stmt =>
					vscode.debug.startDebugging(undefined, { type: 'dbt-sql', request: 'launch', name: 'Run SQL', sql: stmt.sql }),
				));
			}
		}),

		vscode.commands.registerCommand('dbt-studio.executeStatement', async (sql: string) => {
			if (!sql) return;
			await queryRunner.executeSql(sql);
		}),

		vscode.commands.registerCommand('dbt-studio.queryCte', async (modelId: string, cteName: string) => {
			if (!modelId || !cteName) return;
			const rawNode = manifestIndexer.getRawNode(modelId);
			if (!rawNode || rawNode.resource_type !== 'model') return;
			const cteSql = await dbtQueryService.buildCteSql(modelId, cteName);
			if (!cteSql) {
				void vscode.window.showErrorMessage(`CTE '${cteName}' not found in compiled model '${rawNode.name}'`);
				return;
			}
			await queryRunner.executeSql(cteSql);
		}),

		vscode.commands.registerCommand('dbt-studio.queryModel', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const modelId = manifestIndexer.findModelByFilePath(editor.document.fileName);
			if (!modelId) {
				void vscode.window.showWarningMessage('Model is not indexed yet. The startup parse may still be running.');
				return;
			}
			const rawNode = manifestIndexer.getRawNode(modelId);
			if (!rawNode || rawNode.resource_type !== 'model') return;
			const compiledSql = await compileCache.ensureCompiled(
				rawNode.unique_id, rawNode.name, manifestIndexer.projectDir, rawNode.original_file_path,
			);
			if (!compiledSql) {
				void vscode.window.showErrorMessage(`Could not compile model '${rawNode.name}'`);
				return;
			}
			await queryRunner.executeSql(compiledSql);
		}),

		vscode.commands.registerCommand('dbt-studio.queryResult.moveToPanel', () => {
			queryResultPanel.moveToPanel();
		}),

		vscode.commands.registerCommand('dbt-studio.queryResult.moveToEditor', () => {
			queryResultPanel.moveToEditor();
		}),

		vscode.commands.registerCommand('dbt-studio.queryResult.toggleStats', () => {
			queryResultPanel.toggleStats();
		}),

		vscode.commands.registerCommand('dbt-studio.queryResult.exportMenu', async () => {
			const items: vscode.QuickPickItem[] = [
				{ label: '$(copy) Copy as CSV', detail: 'csv' },
				{ label: '$(copy) Copy as TSV', detail: 'tsv' },
				{ label: '$(copy) Copy as JSON', detail: 'json' },
				{ label: '$(copy) Copy as Markdown', detail: 'markdown' },
				{ label: '$(go-to-file) Open in Editor', detail: 'editor' },
			];
			const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Export query results' });
			if (picked?.detail) {
				queryResultPanel.requestExport(picked.detail);
			}
		}),

		vscode.commands.registerCommand('dbt-studio.queryResult.export.csv', () => {
			queryResultPanel.requestExport('csv', 'file');
		}),
		vscode.commands.registerCommand('dbt-studio.queryResult.export.tsv', () => {
			queryResultPanel.requestExport('tsv', 'file');
		}),
		vscode.commands.registerCommand('dbt-studio.queryResult.export.json', () => {
			queryResultPanel.requestExport('json', 'file');
		}),
		vscode.commands.registerCommand('dbt-studio.queryResult.export.markdown', () => {
			queryResultPanel.requestExport('markdown', 'file');
		}),
	);

	// -------- Debug adapter (F5 → run SQL) --------
	const symbolSqlProvider = new SymbolSqlProvider();
	const dataPipelineProvider = new DataPipelineProvider(context.extensionUri);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(SymbolSqlProvider.scheme, symbolSqlProvider),
		vscode.debug.registerDebugConfigurationProvider('dbt-sql', new SqlDebugConfigProvider()),
		vscode.debug.registerDebugConfigurationProvider('dbt-sql', new SqlDebugConfigProvider(), vscode.DebugConfigurationProviderTriggerKind.Dynamic),
		vscode.debug.registerDebugAdapterDescriptorFactory('dbt-sql', {
			createDebugAdapterDescriptor() {
				return new vscode.DebugAdapterInlineImplementation(
					new SqlDebugAdapter(queryRunner, pathResolver, logger, databaseProvider, dbtBridgeRunner, compileCache, manifestIndexer, parseService, symbolSqlProvider),
				);
			},
		}),
		vscode.window.createTreeView(DataPipelineProvider.viewId, {
			treeDataProvider: dataPipelineProvider,
			showCollapseAll: true,
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(e => {
			if (e.session.type !== 'dbt-sql') return;
			if (e.event === 'dbt-sql:pipeline') {
				const sourceUri = e.session.configuration.file as string | undefined;
				dataPipelineProvider.handlePipelineEvent(e.body, sourceUri);
			} else if (e.event === 'dbt-sql:stepResult') {
				const body = e.body as { frameName: string; columns: string[]; columnTypes?: Record<string, string>; rows: Record<string, unknown>[]; rowCount: number; executionTimeMs: number };
				const stepResult: StatementResult = {
					sql: body.frameName,
					index: 0,
					result: {
						columns: body.columns,
						columnTypes: body.columnTypes,
						rows: body.rows,
						rowCount: body.rowCount,
						executionTimeMs: body.executionTimeMs,
					},
				};
				queryResultPanel.showResults([stepResult], undefined, true);
			}
		}),
		vscode.debug.onDidTerminateDebugSession(session => {
			if (session.type === 'dbt-sql') {
				dataPipelineProvider.clear();
				symbolSqlProvider.clear();
			}
		}),
		vscode.commands.registerCommand('dbt-sql.dataPipeline.toggleModeFull', () => dataPipelineProvider.toggleMode()),
		vscode.commands.registerCommand('dbt-sql.dataPipeline.toggleModeStack', () => dataPipelineProvider.toggleMode()),
		vscode.commands.registerCommand('dbt-sql.dataPipeline.goToFrame', async (uri: string, line: number) => {
			if (!uri || line === undefined) return;
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			const pos = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}),
		vscode.commands.registerCommand('dbt-studio.debug.showFrameSql', async (...args: unknown[]) => {
			logger.info('showFrameSql command invoked', { args: args.map(a => JSON.stringify(a)), argsLength: args.length });

			const session = vscode.debug.activeDebugSession;
			if (!session || session.type !== 'dbt-sql') {
				logger.warn('showFrameSql: no active dbt-sql session');
				return;
			}

			// The context menu passes different args - try to find the frame ID
			let frameId: number | undefined;

			// Check if any arg has a frameId or id property
			for (const arg of args) {
				if (arg && typeof arg === 'object') {
					const obj = arg as Record<string, unknown>;
					frameId = obj['frameId'] as number ?? obj['id'] as number ?? obj['frameID'] as number;
					if (frameId !== undefined) {
						logger.info('showFrameSql: found frameId in arg', { frameId, arg: JSON.stringify(arg) });
						break;
					}
				}
			}

			if (frameId === undefined) {
				logger.error('showFrameSql: could not extract frameId from args');
				void vscode.window.showErrorMessage('Could not determine stack frame ID');
				return;
			}

			try {
				await session.customRequest('showFrameSql', { frameId });
				logger.info('showFrameSql request sent successfully');
			} catch (err) {
				logger.error('showFrameSql request failed', err);
			}
		}),
	);

	// -------- Ensure .vscode/launch.json exists with SQL runner configs --------
	void ensureLaunchConfig(vscode.workspace.workspaceFolders?.[0]);

	// -------- Ninja workspace scanner (last — needs everything else ready) --------
	let workspaceScanner: WorkspaceDiagnosticsScanner | undefined;

	const initWorkspaceScanner = (): void => {
		workspaceScanner?.dispose();
		const enabled = vscode.workspace.getConfiguration('dbt-studio').get<boolean>('ninja.workspaceDiagnostics', false);
		if (!enabled) {
			workspaceScanner = undefined;
			return;
		}
		workspaceScanner = new WorkspaceDiagnosticsScanner(parseService, manifestIndexer, pathResolver, logger);
		context.subscriptions.push(workspaceScanner);
		if (startupReady) {
			void workspaceScanner.scanAll();
		}
	};

	initWorkspaceScanner();

	context.subscriptions.push(
		manifestWatcher.onIndexRebuild(({ pivots }) => { void workspaceScanner?.scanAll(pivots); }),
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (doc.languageId === 'jinja-sql') void workspaceScanner?.invalidate(doc.uri);
		}),
		vscode.window.onDidChangeVisibleTextEditors(_editors => { /* scanner no longer owns a collection */ }),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dbt-studio.ninja.workspaceDiagnostics')) initWorkspaceScanner();
			if (e.affectsConfiguration('dbt-studio.ninja') && workspaceScanner) {
				void workspaceScanner.scanAll();
			}
		}),
	);

	logger.info(`dbt Studio v${version} activated.`);
}

/**
 * Run the env manager's install command (e.g. `pipenv install`) inside the
 * project directory and resolve to true on exit code 0.
 */
async function _runBootstrap(cmd: string[], projectDir: string, envVars?: Record<string, string>): Promise<boolean> {
	const { spawn } = await import('node:child_process');
	return new Promise((resolve) => {
		const [executable, ...args] = cmd;
		const child = spawn(executable, args, {
			cwd: projectDir,
			env: { ...process.env, ...envVars },
			windowsHide: true,
		});
		child.on('error', () => resolve(false));
		child.on('close', (code) => resolve(code === 0));
	});
}

async function ensureLaunchConfig(folder: vscode.WorkspaceFolder | undefined): Promise<void> {
	if (!folder) return;
	const launchUri = vscode.Uri.joinPath(folder.uri, '.vscode', 'launch.json');

	const dbtConfigs = [
		{ name: 'Run SQL', type: 'dbt-sql', request: 'launch' },
		{ name: 'Run All SQL', type: 'dbt-sql', request: 'launch', scope: 'all' },
		{ name: 'Debug SQL', type: 'dbt-sql', request: 'launch' },
	];

	let existing: { version: string; configurations: Array<Record<string, unknown>> } = { version: '0.2.0', configurations: [] };
	try {
		const raw = await vscode.workspace.fs.readFile(launchUri);
		existing = JSON.parse(Buffer.from(raw).toString('utf8'));
	} catch {
		// File doesn't exist or is unparseable — start fresh.
	}

	const configs: Array<Record<string, unknown>> = Array.isArray(existing.configurations) ? existing.configurations : [];

	// Only add configs that aren't already present (match by name+type).
	const hasDbtConfig = configs.some(c => c.type === 'dbt-sql');
	if (hasDbtConfig) return;

	const merged = { version: existing.version ?? '0.2.0', configurations: [...configs, ...dbtConfigs] };
	try { await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(folder.uri, '.vscode')); } catch { /* exists */ }
	await vscode.workspace.fs.writeFile(launchUri, Buffer.from(JSON.stringify(merged, null, 4) + '\n', 'utf8'));
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
