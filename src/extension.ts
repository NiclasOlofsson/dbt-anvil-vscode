import * as fs from 'node:fs';
import * as vscode from 'vscode';
import { VSCodeLogger, type ILogger } from './types/logger';
import { ServiceContainer } from './types/service-container';
import { ManifestService } from './indexing/manifest-service';
import { detectPythonEnvironment, validatePythonEnvironment, dbtPackagesExist, checkEnvManagerAvailable, getBootstrapCommand, validateDbtInstalled, followsVsCodeInterpreter } from './dbt/env-detector';
import { getVsCodeInterpreter, onDidChangeVsCodeInterpreter } from './dbt/vscode-python';
import { discoverDbtProject } from './dbt/project-discovery';
import { writeShims } from './dbt/terminal-env';
import { BridgeRunner } from './dbt/bridge-runner';
import { DbtExecutionService, DbtJobType, Priority } from './dbt/execution-service';
import { CompileCache } from './dbt/compile-cache';
import { CompileCachePersistence } from './dbt/compile-cache-persistence';
import { DescribeCache } from './dbt/describe-cache';
import { DbtProjectService } from './dbt/dbt-project-service';
import { DbtPathResolver } from './dbt/dbt-path-resolver';
import { createDatabaseProvider } from './providers/database/database-provider-factory';
import { ColumnStorePersistence } from './indexing/column-store-persistence';
import { ContentHashPersistence } from './indexing/content-hash-persistence';
import { validateLayerConfig, type LayerConfig } from './indexing/layer-classifier';
import { LayersCompletionProvider } from './providers/settings/layers-completion-provider';
import { registerLanguageModelTools } from './tools';
import { McpSubsystem } from './mcp/host';
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
import { SqlCodeActionProvider } from './ninja/code-actions/provider';
import { NinjaFormattingProvider } from './providers/sql/formatting-provider';
import { ConfigCodeActionProvider } from './providers/common/config-code-action-provider';
import { DbtCallHierarchyProvider } from './providers/sql/call-hierarchy-provider';
import { ParseService } from './services/parse-service';
import { SqllensDocumentParser } from './ftl/sqllens/document-parser';
import type { DocumentParser } from './services/document-parser';
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
import { WorkspaceDiagnosticsScanner } from './ninja/diagnostics/scanner';
import { WorkspaceDiagnosticsPersistence } from './ninja/diagnostics/persistence';
import { NinjaEditorPanel } from './ninja/editor';
import * as path from 'node:path';
import { migrateLegacySettings, warnIfLegacyExtensionInstalled } from './migration';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	// -------- Bootstrap logging & service container --------
	const outputChannel = vscode.window.createOutputChannel('dbt Anvil', { log: true });

	if (context.extensionMode === vscode.ExtensionMode.Development) {
		outputChannel.show(true);
	}

	const logger = new VSCodeLogger(outputChannel, context.extensionMode);

	const version = (context.extension.packageJSON as { version: string }).version;
	ServiceContainer.initialize({ extensionContext: context, logger, extensionVersion: version });
	context.subscriptions.push(outputChannel);

	// One-time migration from the previous "dbt Studio" identity (settings,
	// formatter id, and stale MCP wiring). Runs before any config is read.
	await migrateLegacySettings(context, logger);

	// Warn (every activation) if the old "dbt Studio" extension is still
	// enabled alongside this one — they collide on shared/global identifiers.
	warnIfLegacyExtensionInstalled(logger);

	logger.info(`dbt Anvil v${version} activating...`);

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
		logger.warn('No workspace folder open — dbt Anvil may be limited.');
		return;
	}

	// The activation event is `workspaceContains:**/dbt_project.yml`, so a project
	// nested in the folder wakes us up; resolution has to reach as deep.
	const discovery = await discoverDbtProject(workspaceFolders[0].uri);
	const projectDir = discovery.projectDir ?? workspaceFolders[0].uri.fsPath;
	if (discovery.projectDir && discovery.candidates.length > 0) {
		logger.info(`Found dbt project below the workspace root: ${projectDir}`);
	}

	const storageDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
	const extensionTargetDir = path.join(storageDir, 'target');
	const projectService = new DbtProjectService(projectDir, logger);
	context.subscriptions.push({ dispose: () => projectService.dispose() });
	projectService.startWatching();
	const hasDbtProject = !!projectService.projectConfig;

	// Several projects in one folder is not supported yet, and binding to whichever
	// the search returned first would be a silent wrong answer. Say so instead.
	if (discovery.candidates.length > 1) {
		logger.warn(`Several dbt projects found in the workspace: ${discovery.candidates.join(', ')}`);
		void vscode.window.showWarningMessage(
			`dbt Anvil: found ${discovery.candidates.length} dbt projects in this workspace and cannot work on more than one. Open a single project folder to use dbt Anvil.`,
			'Show Output',
		).then((selection) => {
			if (selection === 'Show Output') {
				void vscode.commands.executeCommand('dbt-anvil.showOutputChannel');
			}
		});
	}

	// -------- Detect Python environment --------
	// Always detect (non-intrusive filesystem check), but only validate and show
	// notifications when this is actually a dbt project. Users who have the extension
	// installed on non-dbt workspaces must never see Python/dbt error toasts.
	const configuredPythonPath = vscode.workspace.getConfiguration('dbt-anvil').get<string>('pythonPath', '').trim();
	let pythonEnv = detectPythonEnvironment(projectDir, { configuredPath: configuredPythonPath || undefined });

	// Discovery found nothing in the project: the environment may be central, a
	// sibling folder, or shared across repos. Ask VS Code which interpreter this
	// folder uses. Deferred to here so the Python extension is only activated for
	// the projects that actually need it.
	if (hasDbtProject && followsVsCodeInterpreter(pythonEnv)) {
		const interpreter = await getVsCodeInterpreter(workspaceFolders[0].uri);
		if (interpreter) {
			pythonEnv = detectPythonEnvironment(projectDir, { vscodeInterpreter: interpreter });
		}
	}
	logger.info(`Python environment: ${pythonEnv.description} (${pythonEnv.command.join(' ')})`);

	// A new interpreter only takes effect on the next activation: the bridge process
	// and the terminal shims are both built from the one resolved above.
	if (hasDbtProject && followsVsCodeInterpreter(pythonEnv)) {
		context.subscriptions.push(onDidChangeVsCodeInterpreter(() => {
			void vscode.window.showInformationMessage(
				'dbt Anvil: Python interpreter changed. Reload the window to use it.',
				'Reload Window',
			).then((selection) => {
				if (selection === 'Reload Window') {
					void vscode.commands.executeCommand('workbench.action.reloadWindow');
				}
			});
		}));
	}

	let initError: string | null = null;
	let envReady = false;

	// Validation runs in the background so activation is not blocked.
	// envReady / initError are updated by the IIFE; requireEnv() and the .then()
	// callback below read them once the promise settles.
	const _envInitDone: Promise<void> = !hasDbtProject
		? Promise.resolve()
		: (async () => {
			// Check dbt directly first — success proves the Python env works too, avoiding
			// a separate `pipenv/uv/poetry run python --version` subprocess on the happy path.
			const dbtInstalled = await validateDbtInstalled(pythonEnv, projectDir);

			if (dbtInstalled) {
				envReady = true;
			} else {
				// dbt check failed — diagnose whether Python itself is working.
				envReady = await validatePythonEnvironment(pythonEnv);

				if (!envReady) {
					// Check whether the env manager (pipenv/uv/poetry) is even installed.
					const managerAvailable = await checkEnvManagerAvailable(pythonEnv);
					if (!managerAvailable) {
						const mgr = pythonEnv.description.split(' ')[0]; // e.g. 'pipenv'
						logger.warn(`Environment manager not found on PATH: ${mgr}`);
						initError = `${mgr} is not installed or not on PATH. Install it (e.g. pip install ${mgr}), then reload the window.`;
						void vscode.window.showErrorMessage(
							`dbt Anvil: ${mgr} is not installed or not on PATH. Install it, then reload the window.`,
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
								{ location: vscode.ProgressLocation.Notification, title: 'dbt Anvil: Setting up Python environment…', cancellable: false },
								() => _runBootstrap(bootstrapCmd, projectDir, pythonEnv.envVars),
							);
							if (envReady) {
								envReady = await validatePythonEnvironment(pythonEnv);
							}
							if (!envReady) {
								logger.warn(`Bootstrap completed but Python environment still not working: ${pythonEnv.description}`);
								initError = `Python environment setup failed (${pythonEnv.description}). Check the dbt Anvil output channel for details.`;
								void vscode.window.showErrorMessage(
									'dbt Anvil: Python environment setup failed. See the dbt Anvil output channel for details.',
									'Show Output',
								).then((selection) => {
									if (selection === 'Show Output') {
										void vscode.commands.executeCommand('dbt-anvil.showOutputChannel');
									}
								});
							} else {
								logger.info('Python environment bootstrap succeeded.');
							}
						} else {
							logger.warn(`Python environment validation failed: ${pythonEnv.description}`);
							initError = `Python environment not working (${pythonEnv.description}). dbt features are disabled.`;
							void vscode.window.showWarningMessage(
								`dbt Anvil: Python environment not found or not working (${pythonEnv.description}). dbt features are disabled.`,
								'Reload Window',
							).then((selection) => {
								if (selection === 'Reload Window') {
									void vscode.commands.executeCommand('workbench.action.reloadWindow');
								}
							});
						}
					}
				}

				// Python works but dbt not found — try bootstrapping.
				if (envReady && !initError) {
					logger.warn(`dbt not found in Python environment: ${pythonEnv.description}`);
					const bootstrapCmd = getBootstrapCommand(pythonEnv, projectDir);
					if (bootstrapCmd) {
						logger.info(`dbt missing — bootstrapping environment: ${bootstrapCmd.join(' ')}`);
						const bootstrapOk = await vscode.window.withProgress(
							{ location: vscode.ProgressLocation.Notification, title: 'dbt Anvil: Installing project dependencies…', cancellable: false },
							() => _runBootstrap(bootstrapCmd, projectDir, pythonEnv.envVars),
						);
						if (bootstrapOk && await validateDbtInstalled(pythonEnv, projectDir)) {
							logger.info('Bootstrap succeeded — dbt is now available.');
						} else {
							logger.warn(`dbt still not found after bootstrap: ${pythonEnv.description}`);
							initError = `dbt is not installed in the Python environment (${pythonEnv.description}). Add dbt to your project dependencies and reload.`;
							void vscode.window.showErrorMessage(
								'dbt Anvil: dbt is not installed in the Python environment. Add it to your project dependencies and reload the window.',
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
							'dbt Anvil: dbt is not installed in the Python environment. Add it to your project dependencies and reload the window.',
							'Reload Window',
						).then((selection) => {
							if (selection === 'Reload Window') {
								void vscode.commands.executeCommand('workbench.action.reloadWindow');
							}
						});
					}
				}
			}
		})();

	// -------- Terminal environment setup --------
	// Shims are written after background env validation completes (see _envInitDone.then below).
	// Clear immediately so a stale shim from a previous session never leaks into new terminals.
	const contributeCliShim = vscode.workspace.getConfiguration('dbt-anvil').get<boolean>('terminal.contributeCliShim', true);
	context.environmentVariableCollection.clear();

	// -------- Set up manifest loading and indexing --------
	const manifestService = new ManifestService(projectService, extensionTargetDir, logger);
	const manifestLoader = manifestService.loader;
	const manifestIndexer = manifestService.indexer;

	const container = ServiceContainer.getInstance();
	container.setManifestLoader(manifestLoader);
	container.setManifestIndexer(manifestIndexer);

	// -------- Walkthrough / setup context keys --------
	// Publish the setup pipeline's state as context keys so the "Get Started"
	// walkthrough ticks each step off as the extension clears the gate, whether
	// that happens automatically (background deps/parse) or via a manual command.
	// envReady/initError are read from the activation closure; deps/manifest come
	// straight from the filesystem. connectionOk is transient per session.
	let connectionOk = false;
	const updateSetupContext = (conn?: boolean): void => {
		if (conn !== undefined) connectionOk = conn;
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.projectReady', hasDbtProject);
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.envReady', envReady && !initError);
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.depsReady', dbtPackagesExist(projectDir));
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.manifestReady', manifestLoader.manifestExists());
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.connectionOk', connectionOk);
	};
	// Baseline every completion key to false synchronously, before any real value.
	// The Get Started service completes an onContext step only on a false->true
	// transition it observes while listening. A key already true at activation (a
	// warm project) is missed, so we emit false here and let the post-async
	// updateSetupContext calls below publish the real values as observed transitions.
	for (const key of ['projectReady', 'envReady', 'depsReady', 'manifestReady', 'connectionOk']) {
		void vscode.commands.executeCommand('setContext', `dbt-anvil.${key}`, false);
	}

	// -------- Column store persistence --------
	const columnStorePersistence = new ColumnStorePersistence(context, logger);
	// Restore before first build so _diffAndInvalidate only evicts changed nodes
	columnStorePersistence.restore(manifestIndexer);

	// -------- Layer configuration --------
	// Load user-configured layers before the first build so models are classified on index.
	manifestIndexer.setLayerConfigs(loadLayerConfigs(logger));

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

	// deps check and startup parse are triggered from _envInitDone.then() below.
	let startupBootstrapTriggered = false;
	let runStartupBootstrapParse: (() => Promise<void>) | undefined;
	let ensureIndexReady: (() => Promise<void>) | undefined;

	// -------- Compile cache (shared across all tools) --------
	const compileCache = new CompileCache(executionService, manifestLoader, logger);
	const compileCachePersistence = new CompileCachePersistence(context, logger);
	const restoredCompileEntries = compileCachePersistence.restore(compileCache, projectDir);
	context.subscriptions.push({ dispose: () => compileCachePersistence.save(compileCache) });

	// -------- Describe cache (shared across providers and tools) --------
	const describeCache = new DescribeCache(executionService, manifestIndexer, logger);
	context.subscriptions.push(describeCache.onDescribeError((failedId) => {
		const resourceType = failedId.split('.')[0];
		let message: string;
		let action: string | undefined;
		let dbtArgs: string[] | undefined;
		let dbtType: DbtJobType | undefined;

		if (resourceType === 'seed') {
			message = 'Could not describe some tables — seed data may not be loaded yet. Run dbt seed to load your seed files.';
			action = 'Run dbt seed';
			dbtArgs = ['seed'];
			dbtType = 'seed';
		} else if (resourceType === 'model') {
			const modelName = failedId.split('.')[2] ?? failedId;
			message = `Could not describe '${modelName}' — it may not be built yet. "Run dbt build" will run: dbt build --select +${modelName} (builds the model and all its upstream dependencies).`;
			action = 'Run dbt build';
			dbtArgs = ['build', '--select', `+${modelName}`];
			dbtType = 'build';
		} else if (resourceType === 'source') {
			message = 'Could not describe some sources — the underlying warehouse tables may not exist yet.';
		} else {
			message = 'Could not describe some tables — they may not exist in the warehouse yet.';
		}

		void vscode.window.showWarningMessage(message, ...(action ? [action] : [])).then((selection) => {
			if (selection && dbtArgs && dbtType) {
				void executionService.submit({
					type: dbtType, args: dbtArgs,
					priority: Priority.User, origin: 'user', label: dbtType,
				}).then((result) => {
					if (result.success) {
						void vscode.window.showInformationMessage(`dbt ${dbtType}: success`);
					} else {
						const detail = result.stdout.trim() || result.stderr.trim() || 'no output';
						void vscode.window.showErrorMessage(`dbt ${dbtType}: failed — ${detail}`);
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
	context.subscriptions.push(statusBar);

	// Once background env validation settles: write shims, surface any error in the
	// status bar, and kick off startup deps / parse if the environment is healthy.
	void _envInitDone.then(() => {
		if (contributeCliShim && envReady) {
			try {
				const shimsDir = path.join(storageDir, 'shims');
				logger.info(`Creating terminal shims at: ${shimsDir}`);
				const shimPath = writeShims(shimsDir, pythonEnv);
				if (shimPath) {
					context.environmentVariableCollection.prepend('PATH', shimPath + path.delimiter);
					context.environmentVariableCollection.description = `dbt Anvil: activated ${pythonEnv.description}`;
					logger.info(`Terminal shim contributed: ${shimPath}`);
				} else {
					logger.info('No terminal shim needed (system Python)');
				}
			} catch (err) {
				logger.error(`Failed to create terminal shims: ${err}`);
			}
		}

		// Env validation has settled — publish env readiness (and refresh deps/manifest).
		updateSetupContext();

		if (initError) {
			statusBar.setError(initError);
			return;
		}

		if (!envReady || !hasDbtProject) return;

		if (!dbtPackagesExist(projectDir)) {
			logger.info('dbt_packages is missing — running startup dbt deps bootstrap');
			void executionService.submit({
				type: 'deps', args: ['deps'],
				priority: Priority.Background, origin: 'background', label: 'install deps (startup bootstrap)',
			}).then((result) => {
				if (result.success) {
					void vscode.window.showInformationMessage('dbt deps: success');
					updateSetupContext();
					void ensureIndexReady?.();
				} else {
					const msg = `Startup deps failed: ${result.stdout.trim() || result.stderr.trim()}`;
					logger.warn(msg);
					void vscode.window.showErrorMessage(`dbt deps: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
				}
			});
		} else {
			void ensureIndexReady?.();
		}
	}).catch((err: unknown) => {
		logger.error(`Unexpected error during environment validation: ${err}`);
		initError = `Unexpected error during environment setup: ${err}`;
		statusBar.setError(initError);
	});

	// -------- External dbt monitor (detect conflicting terminal dbt commands) --------
	if (vscode.workspace.getConfiguration('dbt-anvil').get<boolean>('terminal.externalCommandMonitor.enabled', true)) {
		const externalDbtMonitor = new ExternalDbtMonitor(projectDir, executionService, manifestWatcher, logger, context);
		externalDbtMonitor.start();
		context.subscriptions.push(externalDbtMonitor);
	} else {
		logger.warn('ExternalDbtMonitor is disabled via dbt-anvil.terminal.externalCommandMonitor.enabled — concurrent terminal dbt commands may corrupt the manifest.');
	}

	// Kick off a full compile to warm the cache. Skipped if enough valid entries
	// were restored from disk (mtime validation happens on first access per entry).
	// Persist as soon as the warm completes so a populated cache survives a hard
	// shutdown — deactivate/dispose is not guaranteed to run (window reload, crash).
	// Mirrors the checkpoint-save the ColumnStore already does on manifest refresh.
	void compileCache.warmAll(projectDir, restoredCompileEntries).then(() => {
		compileCachePersistence.save(compileCache);
	});

	// -------- Parse service — sqllens native parser, synchronous and in-process --------
	const documentParser: DocumentParser = new SqllensDocumentParser(manifestIndexer);
	const parseService = new ParseService(documentParser, logger, { describeCache, indexer: manifestIndexer });

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
	const diagnosticsProvider = new EditorDiagnosticsProvider(executionService, manifestIndexer, statusBar, projectDir, logger, parseService, manifestWatcher.onIndexRebuild, parseService.onParseWarnings, startupReady);
	context.subscriptions.push(diagnosticsProvider);

	// -------- Set workspaceHasDBT context --------
	// This context means "dbt project is present", not "manifest already exists".
	// Cold start must still show the extension UI/actions before the first parse/compile
	// creates the manifest in the extension target folder.
	void vscode.commands.executeCommand('setContext', 'workspaceHasDBT', hasDbtProject);

	// -------- Start MCP subsystem (Claude Code + any other MCP client) --------
	const mcpSubsystem = new McpSubsystem(logger);
	context.subscriptions.push({
		dispose: () => { void mcpSubsystem.dispose(); },
	});
	const mcpStart = mcpSubsystem.start(context).catch(err => {
		logger.warn(`MCP subsystem failed to start: ${err instanceof Error ? err.message : String(err)}`);
		return null;
	});

	// -------- Register language model tools (Copilot + MCP registry) --------
	registerLanguageModelTools(context, manifestIndexer, executionService, manifestLoader, logger, compileCache, databaseProvider, describeCache, dbtQueryService, documentParser, mcpSubsystem.registry);

	// Surface a one-time toast when the Claude Code config actually changed,
	// since Claude Code doesn't hot-reload ~/.claude.json.
	void mcpStart.then(result => {
		if (result?.configChanged) {
			void vscode.window.showInformationMessage(
				'dbt Anvil MCP tools registered — restart Claude Code to activate.',
			);
		}
	});

	// -------- Register tree views --------
	const modelExplorerProvider = new ModelExplorerProvider(manifestIndexer, logger, projectDir, context.globalState);
	const lineageGraphProvider = new LineageGraphProvider(manifestIndexer, logger, context.globalState, context.workspaceState);
	const columnLineageTool = new GetColumnLineageTool(manifestIndexer, logger, compileCache, describeCache, documentParser);
	lineageGraphProvider.setColumnLineageTool(columnLineageTool);
	lineageGraphProvider.setExecutionService(executionService);
	// Initialise context keys so the correct toolbar icons show from the start
	void vscode.commands.executeCommand('setContext', 'dbt-anvil.lineageFollowActive', lineageGraphProvider.followActive);
	void vscode.commands.executeCommand('setContext', 'dbt-anvil.lineage.showTests', lineageGraphProvider.showTests);
	void vscode.commands.executeCommand('setContext', 'dbt-anvil.explorerFollowActive', modelExplorerProvider.followActive);
	void vscode.commands.executeCommand('setContext', ProfilerDecorationProvider.contextKey, true);
	const testExplorerProvider = new TestExplorerProvider(manifestIndexer, manifestLoader, logger);

	const modelExplorerView = vscode.window.createTreeView('dbt-anvil.modelExplorer', {
		treeDataProvider: modelExplorerProvider,
		showCollapseAll: true,
	});

	context.subscriptions.push(
		modelExplorerView,
		vscode.window.registerWebviewViewProvider(LineageGraphProvider.viewId, lineageGraphProvider),
		vscode.window.registerTreeDataProvider('dbt-anvil.testExplorer', testExplorerProvider),
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
			updateSetupContext();
			void dbtBridgeRunner.invalidateManifestCache();
		}),
	);

	/** Everything that has to happen the moment the index exists: views fill, the status bar leaves "Initializing". */
	const publishIndexReady = async (): Promise<void> => {
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
		updateSetupContext();
	};

	runStartupBootstrapParse = async (): Promise<void> => {
		if (startupBootstrapTriggered) return;
		startupBootstrapTriggered = true;

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
				const msg = `Startup parse failed: ${result.stdout.trim() || result.stderr.trim()}`;
				logger.warn(msg);
				statusBar.setError(msg);
				return;
			}
			try {
				manifestIndexer.build(true);
				await publishIndexReady();
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
	};

	/**
	 * Bring the index up on a cold start, where activation had no manifest to
	 * build from and every view is therefore empty.
	 *
	 * The warm-cache compile runs in parallel with environment validation and
	 * writes a manifest of its own, so by the time this runs the manifest may
	 * already be there. Then indexing it is all that is left, and asking for
	 * another parse would be asking dbt to redo work it has just done.
	 */
	ensureIndexReady = async (): Promise<void> => {
		if (manifestIndexer.index) return;

		if (!manifestLoader.manifestExists()) {
			await runStartupBootstrapParse?.();
			return;
		}

		logger.info('Manifest present but never indexed on startup — building the index');
		try {
			manifestIndexer.build(true);
			await publishIndexReady();
			logger.info('Manifest index built from the existing manifest');
		} catch (err) {
			const msg = `Manifest index build failed: ${err}`;
			logger.warn(msg);
			statusBar.setError(msg);
		}
	};

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
		void vscode.commands.executeCommand('setContext', 'dbt-anvil.fileCategory', category);
	};
	context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(updateFileCategory));
	updateFileCategory(vscode.window.activeTextEditor);

	// -------- Register language providers (dynamic, re-registered on path changes) --------
	const definitionProvider = new DbtDefinitionProvider(manifestIndexer, manifestLoader, logger, parseService);
	const hoverProvider = new DbtHoverProvider(manifestIndexer, logger, parseService);
	const completionProvider = new DbtCompletionProvider(logger, parseService);
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
	const signatureHelpProvider = new DbtSignatureHelpProvider(manifestIndexer, logger, parseService);
	const sqlCodeActionProvider = new SqlCodeActionProvider(manifestIndexer, logger);
	sqlCodeActionProvider.setPathResolver(pathResolver);
	sqlCodeActionProvider.setNinjaResultProvider(uri => diagnosticsProvider.getNinjaResult(uri));
	const ninjaFormattingProvider = new NinjaFormattingProvider(parseService, logger);
	const configCodeActionProvider = new ConfigCodeActionProvider();
	const callHierarchyProvider = new DbtCallHierarchyProvider(manifestIndexer, logger, parseService);

	let providerDisposables: vscode.Disposable[] = [];
	let sqlSelector: vscode.DocumentFilter[] = [];

	const registerProviders = (): void => {
		// Dispose previous registrations
		for (const d of providerDisposables) d.dispose();

		sqlSelector = pathResolver.buildSqlSelector();
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
		vscode.workspace.onWillSaveTextDocument(e => {
			const { loadConfig } = require('./ninja/config-loader') as typeof import('./ninja/config-loader');
			const config = loadConfig();
			if (!config.enabled || !config.autoFix.applyOnFixAll) return;
			if (!sqlSelector.some(s => vscode.languages.match(s, e.document))) return;
			e.waitUntil(ninjaFormattingProvider.provideDocumentFormattingEdits(
				e.document,
				{ tabSize: 4, insertSpaces: true },
				new vscode.CancellationTokenSource().token,
			));
		}),
	);

	const requireEnv = (): boolean => {
		if (!envReady) {
			const msg = initError
				? `dbt environment error (${pythonEnv.description}): ${initError}`
				: 'dbt Anvil is still initializing — please try again in a moment.';
			void vscode.window.showWarningMessage(msg, ...(initError ? ['Reload Window'] as const : [])).then((selection) => {
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
		vscode.commands.registerCommand('dbt-anvil.showOutputChannel', () => {
			outputChannel.show(true);
		}),
		vscode.commands.registerCommand('dbt-anvil.suppressSqlFluffWarning', async () => {
			await vscode.workspace.getConfiguration('dbt-anvil').update('notifications.suppressSqlFluffWarning', true, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('dbt-anvil.suppressAutoSaveWarning', async () => {
			await vscode.workspace.getConfiguration('dbt-anvil').update('notifications.suppressAutoSaveWarning', true, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('dbt-anvil.setAsDefaultFormatter', async () => {
			await vscode.workspace.getConfiguration('editor', { languageId: 'jinja-sql' }).update('defaultFormatter', 'nickeolofsson.dbt-anvil-vscode', vscode.ConfigurationTarget.Global, true);
		}),
		vscode.commands.registerCommand('dbt-anvil.suppressFormatterWarning', async () => {
			await vscode.workspace.getConfiguration('dbt-anvil').update('notifications.suppressFormatterWarning', true, vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand('dbt-anvil.ninja.scanWorkspace', () => { void workspaceScanner?.scanAll(); }),
		vscode.commands.registerCommand('dbt-anvil.ninja.openRuleEditor', () => {
			const panel = NinjaEditorPanel.getInstance();
			panel.setScanner(workspaceScanner);
			void panel.open();
		}),
		vscode.commands.registerCommand('dbt-anvil.ninja.statusBarMenu', async () => {
			const items: vscode.QuickPickItem[] = [
				{ label: '$(search) Rescan all files', description: 'Run Ninja on every SQL file in the workspace' },
				{ label: '$(edit) Rule Editor', description: 'Open the Ninja Rule Editor' },
				{ label: '$(warning) Open Problems panel', description: 'Show all Ninja diagnostics' },
				{ label: '$(gear) Open Ninja settings', description: 'Configure dbt-anvil.ninja options' },
				{ label: '$(trash) Clear Ninja diagnostics', description: 'Remove all Ninja issues from the Problems panel' },
			];
			const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Ninja workspace diagnostics' });
			if (!pick) return;
			if (pick.label.includes('Rescan')) {
				void workspaceScanner?.scanAll();
			} else if (pick.label.includes('Rule Editor')) {
				void vscode.commands.executeCommand('dbt-anvil.ninja.openRuleEditor');
			} else if (pick.label.includes('Open Problems')) {
				void vscode.commands.executeCommand('workbench.action.problems.focus');
			} else if (pick.label.includes('settings')) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'dbt-anvil.ninja');
			} else if (pick.label.includes('Clear')) {
				workspaceScanner?.clear();
			}
		}),
		vscode.commands.registerCommand('dbt-anvil.statusBarMenu', async () => {
			const items: vscode.QuickPickItem[] = [
				{ label: '$(trash) Clear All Caches', description: 'Hard reset — wipes all cached data from memory and disk' },
				{ label: '$(gear) Open Settings', description: 'Configure dbt Anvil options' },
				{ label: '$(output) Show Output Channel', description: 'Open the dbt Anvil output log' },
			];
			const pick = await vscode.window.showQuickPick(items, { placeHolder: 'dbt Anvil' });
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
					for (const file of ['compile-cache.json', 'column-store.json', 'content-hashes.json', 'profile-results.json', 'ninja-scan-hashes.json', 'workspace-ninja-diagnostics.json']) {
						try { fs.unlinkSync(`${storageDir}/${file}`); } catch { /* ignore if absent */ }
					}
				}
				void vscode.window.showInformationMessage('All caches cleared.');
			} else if (pick.label.includes('Settings')) {
				void vscode.commands.executeCommand('workbench.action.openSettings', 'dbt-anvil');
			} else if (pick.label.includes('Output')) {
				void vscode.commands.executeCommand('dbt-anvil.showOutputChannel');
			}
		}),
		vscode.commands.registerCommand('dbt-anvil.goToLine', async (args: { uri: string; line: number }) => {
			const uri = vscode.Uri.parse(args.uri);
			const pos = new vscode.Position(args.line, 0);
			await vscode.window.showTextDocument(uri, { selection: new vscode.Range(pos, pos), preserveFocus: false });
		}),

		vscode.commands.registerCommand('dbt-anvil.refreshExplorer', () => {
			modelExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-anvil.runModel', async () => {
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
				void vscode.window.showErrorMessage(`dbt run ${model}: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
			}
			modelExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-anvil.testModel', async () => {
			if (!requireEnv()) return;
			const model = getActiveModelName();
			if (!model) return;
			await vsTestController.runTestsForModel(model);
		}),

		vscode.commands.registerCommand('dbt-anvil.buildModel', async () => {
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
				void vscode.window.showErrorMessage(`dbt build ${model}: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
			}
			modelExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-anvil.compileModel', async () => {
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
				void vscode.window.showErrorMessage(`dbt compile ${model}: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.showLineage', () => {
			void (async () => {
				const model = getActiveModelName();
				if (!model) return;
				const models = manifestIndexer.findModelsByName(model);
				if (models.length === 0) {
					void vscode.window.showWarningMessage(`Model "${model}" not found in manifest yet. The startup parse may still be running.`);
					return;
				}
				lineageGraphProvider.setFocusModel(models[0].uniqueId);
				void vscode.commands.executeCommand('dbt-anvil.lineageGraph.focus');
			})();
		}),

		vscode.commands.registerCommand('dbt-anvil.toggleLineageFollow', () => {
			lineageGraphProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-anvil.toggleLineageFollowOff', () => {
			lineageGraphProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-anvil.toggleExplorerFollow', () => {
			modelExplorerProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-anvil.toggleExplorerFollowOff', () => {
			modelExplorerProvider.toggleFollow();
		}),

		vscode.commands.registerCommand('dbt-anvil.showLineageTests', () => {
			lineageGraphProvider.setShowTests(true);
		}),

		vscode.commands.registerCommand('dbt-anvil.hideLineageTests', () => {
			lineageGraphProvider.setShowTests(false);
		}),

		vscode.commands.registerCommand('dbt-anvil.toggleLineageTests', () => {
			lineageGraphProvider.setShowTests(!lineageGraphProvider.showTests);
		}),

		vscode.commands.registerCommand('dbt-anvil.refreshTestExplorer', () => {
			testExplorerProvider.refresh();
		}),

		vscode.commands.registerCommand('dbt-anvil.runDeps', async () => {
			if (!requireEnv()) return;
			const result = await executionService.submit({
				type: 'deps', args: ['deps'],
				priority: Priority.User, origin: 'user', label: 'install deps',
			});
			if (result.success) {
				void vscode.window.showInformationMessage('dbt deps: success');
				updateSetupContext();
				if (!manifestLoader.manifestExists()) {
					void runStartupBootstrapParse?.();
				}
			} else {
				void vscode.window.showErrorMessage(`dbt deps: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.parseProject', async () => {
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
				updateSetupContext();
			} else {
				void vscode.window.showErrorMessage(`dbt parse: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.debugConnection', async () => {
			if (!requireEnv()) return;
			const result = await executionService.submit({
				type: 'debug', args: ['debug'],
				priority: Priority.User, origin: 'user', label: 'debug',
			});
			if (result.success) {
				updateSetupContext(true);
				void vscode.window.showInformationMessage('dbt debug: connection OK');
			} else {
				void vscode.window.showErrorMessage(`dbt debug: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.getStarted', () => {
			void vscode.commands.executeCommand('workbench.action.openWalkthrough', 'nickeolofsson.dbt-anvil-vscode#dbtAnvilSetup');
		}),

		vscode.commands.registerCommand('dbt-anvil.createModelFile', async (modelName: string) => {
			const folders = vscode.workspace.workspaceFolders;
			if (!folders) return;
			const modelsDir = vscode.Uri.joinPath(folders[0].uri, 'models');
			const fileUri = vscode.Uri.joinPath(modelsDir, `${modelName}.sql`);
			const content = new TextEncoder().encode(`-- ${modelName}\nselect\n    1 as id\n`);
			await vscode.workspace.fs.writeFile(fileUri, content);
			const doc = await vscode.workspace.openTextDocument(fileUri);
			await vscode.window.showTextDocument(doc);
		}),

		vscode.commands.registerCommand('dbt-anvil.inlineRefs', async (uri: vscode.Uri) => {
			const doc = await vscode.workspace.openTextDocument(uri);
			const inlined = sqlCodeActionProvider.inlineRefs(doc.getText());
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), inlined);
			await vscode.workspace.applyEdit(edit);
		}),

		vscode.commands.registerCommand('dbt-anvil.restoreRefs', async (uri: vscode.Uri) => {
			const doc = await vscode.workspace.openTextDocument(uri);
			const restored = sqlCodeActionProvider.restoreRefs(doc.getText());
			const edit = new vscode.WorkspaceEdit();
			edit.replace(uri, new vscode.Range(0, 0, doc.lineCount, 0), restored);
			await vscode.workspace.applyEdit(edit);
		}),

		// ---- Test running commands (for explorer + CodeLens) ----

		vscode.commands.registerCommand('dbt-anvil.runNamedModel', async (modelName: string) => {
			if (!requireEnv()) return;
			const result = await executionService.submit({
				type: 'run', args: ['run', '-s', modelName],
				priority: Priority.User, origin: 'user', label: `run ${modelName}`,
			});
			if (result.success) {
				void vscode.window.showInformationMessage(`dbt run ${modelName}: success`);
			} else {
				void vscode.window.showErrorMessage(`dbt run ${modelName}: failed — ${result.stdout.trim() || result.stderr.trim() || 'no output'}`);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.testNamedModel', async (modelName: string) => {
			if (!requireEnv()) return;
			await vsTestController.runTestsForModel(modelName);
		}),

		vscode.commands.registerCommand('dbt-anvil.runUnitTest', async (_modelName: string, testName: string) => {
			const uid = testExplorerProvider.resolveUidByName(testName);
			if (uid) {
				await vsTestController.runTests([uid]);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.runCteTest', async (_yamlFilePath: string, testName: string) => {
			const uid = testExplorerProvider.resolveUidByName(testName);
			if (uid) {
				await vsTestController.runTests([uid]);
			} else {
				void vscode.window.showWarningMessage(`CTE test '${testName}' not found in tree — refresh the Test Explorer.`);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.runTestFromExplorer', async (item: unknown) => {
			const testItem = item as { uniqueId: string } | undefined;
			if (!testItem?.uniqueId) return;
			await vsTestController.runTests([testItem.uniqueId]);
		}),

		vscode.commands.registerCommand('dbt-anvil.runTestGroupFromExplorer', async (item: unknown) => {
			const group = item as { children: Array<{ uniqueId: string }> } | undefined;
			if (!group?.children) return;
			await vsTestController.runTests(group.children.map(c => c.uniqueId));
		}),

		vscode.commands.registerCommand('dbt-anvil.runTestCategoryFromExplorer', async (item: unknown) => {
			const category = item as { children: Array<{ children: Array<{ uniqueId: string }> }> } | undefined;
			if (!category?.children) return;
			const uids = category.children.flatMap(g => g.children).map(n => n.uniqueId);
			await vsTestController.runTests(uids);
		}),

		vscode.commands.registerCommand('dbt-anvil.runAllTestsFromExplorer', async () => {
			await vsTestController.runTests();
		}),

		vscode.commands.registerCommand('dbt-anvil.openSettings', () => {
			void vscode.commands.executeCommand('workbench.action.openSettings', '@ext:nickeolofsson.dbt-anvil-vscode');
		}),

		// ---- Profiler commands ----

		vscode.commands.registerCommand('dbt-anvil.profiler.profileModel', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'jinja-sql') {
				void vscode.window.showWarningMessage('Open a dbt SQL model file to profile it.');
				return;
			}
			void vscode.commands.executeCommand('setContext', 'dbt-anvil.profilingActive', true);
			try {
				await modelProfiler.profileDocument(editor.document);
			} catch (err) {
				void vscode.window.showErrorMessage(`Profile failed: ${err}`);
			} finally {
				void vscode.commands.executeCommand('setContext', 'dbt-anvil.profilingActive', false);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.profiler.clearResults', () => {
			modelProfiler.clearAll();
		}),

		vscode.commands.registerCommand('dbt-anvil.profiler.cancelProfiling', () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) return;
			const result = modelProfiler.getResultForFile(editor.document.fileName);
			if (result?.status === 'running') {
				modelProfiler.cancelProfiling(result.modelId);
			}
		}),

		vscode.commands.registerCommand('dbt-anvil.profiler.goToCte', async (filePath: string, cteName: string) => {
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

		vscode.commands.registerCommand('dbt-anvil.profiler.showDecorations', () => {
			if (!profilerDecorationProvider.visible) {
				profilerDecorationProvider.toggle();
			}
			void vscode.commands.executeCommand('setContext', ProfilerDecorationProvider.contextKey, true);
		}),

		vscode.commands.registerCommand('dbt-anvil.profiler.hideDecorations', () => {
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
		vscode.commands.registerCommand('dbt-anvil.executeQuery', async () => {
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
			await vscode.debug.startDebugging(undefined, { type: 'dbt-sql', request: 'launch', name: 'Run SQL', scope: 'cursor', noDebug: true });
		}),

		vscode.commands.registerCommand('dbt-anvil.executeAll', async () => {
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
			await vscode.debug.startDebugging(undefined, { type: 'dbt-sql', request: 'launch', name: 'Run All SQL', scope: 'all', noDebug: true });
		}),

		vscode.commands.registerCommand('dbt-anvil.executeStatement', async (sql: string) => {
			if (!sql) return;
			await queryRunner.executeSql(sql);
		}),

		vscode.commands.registerCommand('dbt-anvil.queryCte', async (modelId: string, cteName: string) => {
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

		vscode.commands.registerCommand('dbt-anvil.queryModel', async () => {
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

		vscode.commands.registerCommand('dbt-anvil.queryResult.moveToPanel', () => {
			queryResultPanel.moveToPanel();
		}),

		vscode.commands.registerCommand('dbt-anvil.queryResult.moveToEditor', () => {
			queryResultPanel.moveToEditor();
		}),

		vscode.commands.registerCommand('dbt-anvil.queryResult.toggleStats', () => {
			queryResultPanel.toggleStats();
		}),

		vscode.commands.registerCommand('dbt-anvil.queryResult.exportMenu', async () => {
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

		vscode.commands.registerCommand('dbt-anvil.queryResult.export.csv', () => {
			queryResultPanel.requestExport('csv', 'file');
		}),
		vscode.commands.registerCommand('dbt-anvil.queryResult.export.tsv', () => {
			queryResultPanel.requestExport('tsv', 'file');
		}),
		vscode.commands.registerCommand('dbt-anvil.queryResult.export.json', () => {
			queryResultPanel.requestExport('json', 'file');
		}),
		vscode.commands.registerCommand('dbt-anvil.queryResult.export.markdown', () => {
			queryResultPanel.requestExport('markdown', 'file');
		}),
	);

	// -------- Debug adapter (F5 → debug SQL; Ctrl+F5 / Execute Query → run) --------
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
		vscode.commands.registerCommand('dbt-anvil.dataPipeline.toggleModeFull', () => dataPipelineProvider.toggleMode()),
		vscode.commands.registerCommand('dbt-anvil.dataPipeline.toggleModeStack', () => dataPipelineProvider.toggleMode()),
		vscode.commands.registerCommand('dbt-anvil.dataPipeline.goToFrame', async (uri: string, line: number) => {
			if (!uri || line === undefined) return;
			const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri));
			const editor = await vscode.window.showTextDocument(doc, { preview: false });
			const pos = new vscode.Position(line, 0);
			editor.selection = new vscode.Selection(pos, pos);
			editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
		}),
		vscode.commands.registerCommand('dbt-anvil.debug.showFrameSql', async (...args: unknown[]) => {
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

	// -------- Ninja workspace scanner (last — needs everything else ready) --------
	let workspaceScanner: WorkspaceDiagnosticsScanner | undefined;
	const workspaceDiagnosticsPersistence = new WorkspaceDiagnosticsPersistence(context, logger);

	const initWorkspaceScanner = (): void => {
		if (workspaceScanner) {
			workspaceDiagnosticsPersistence.save(workspaceScanner.getSnapshot());
			workspaceScanner.dispose();
		}
		const enabled = vscode.workspace.getConfiguration('dbt-anvil').get<boolean>('ninja.workspaceDiagnostics', false);
		if (!enabled) {
			workspaceScanner = undefined;
			return;
		}
		workspaceScanner = new WorkspaceDiagnosticsScanner(parseService, manifestIndexer, pathResolver, logger);
		const restored = workspaceDiagnosticsPersistence.restore();
		if (restored) {
			const applied = workspaceScanner.restoreSnapshot(restored);
			logger.debug(`WorkspaceNinja: startup restore ${applied ? 'applied' : 'skipped (config changed)'}`);
		}
		context.subscriptions.push(workspaceScanner);
		if (startupReady) {
			void workspaceScanner.scanAll();
		}
	};

	initWorkspaceScanner();

	context.subscriptions.push(
		{ dispose: () => { if (workspaceScanner) workspaceDiagnosticsPersistence.save(workspaceScanner.getSnapshot()); } },
		manifestWatcher.onIndexRebuild(({ pivots }) => { void workspaceScanner?.scanAll(pivots); }),
		vscode.workspace.onDidSaveTextDocument(doc => {
			if (doc.languageId === 'jinja-sql') void workspaceScanner?.invalidate(doc.uri);
		}),
		vscode.workspace.onDidOpenTextDocument(doc => {
			// When a document opens, EditorDiagnosticsProvider takes over Ninja diagnostics.
			// Clear the scanner's copy so the two collections don't both show the same violations.
			if (doc.languageId === 'jinja-sql') workspaceScanner?.suppressUri(doc.uri);
		}),
		vscode.workspace.onDidCloseTextDocument(doc => {
			// When a document is closed, EditorDiagnosticsProvider no longer covers it.
			// Re-scan so the workspace scanner picks it up and shows diagnostics in the gutter.
			if (doc.languageId === 'jinja-sql') void workspaceScanner?.invalidate(doc.uri);
		}),
		vscode.window.onDidChangeVisibleTextEditors(_editors => { /* scanner no longer owns a collection */ }),
		vscode.workspace.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('dbt-anvil.ninja.workspaceDiagnostics')) initWorkspaceScanner();
			if (e.affectsConfiguration('dbt-anvil.ninja') && workspaceScanner) {
				workspaceScanner.invalidateAllCaches();
				void workspaceScanner.scanAll();
			}
			if (e.affectsConfiguration('dbt-anvil.layers')) {
				manifestIndexer.setLayerConfigs(loadLayerConfigs(logger));
			}
		}),
		vscode.languages.registerCompletionItemProvider(
			[{ language: 'json' }, { language: 'jsonc' }],
			new LayersCompletionProvider(manifestIndexer),
			'"', ':', '[', '{', ',', ' ',
		),
	);

	logger.info(`dbt Anvil v${version} activated.`);
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

/**
 * Read `dbt-anvil.layers` from workspace configuration, validate it, and return
 * the resolved array. Invalid entries are dropped and logged; a totally invalid
 * config yields an empty array so indexing continues unaffected.
 */
function loadLayerConfigs(logger: ILogger): LayerConfig[] {
	const raw = vscode.workspace.getConfiguration('dbt-anvil').get<unknown>('layers');
	if (raw === undefined || raw === null) return [];
	const errors = validateLayerConfig(raw);
	if (errors.length > 0) {
		logger.warn(`dbt-anvil.layers has ${errors.length} validation error(s): ${errors.join('; ')}`);
		return [];
	}
	return raw as LayerConfig[];
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
