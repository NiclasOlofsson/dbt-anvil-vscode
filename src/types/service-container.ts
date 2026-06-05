import * as vscode from 'vscode';
import type { ILogger } from './logger';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { IManifestSuppressor } from '../indexing/manifest-watcher';
import type { DatabaseProvider } from '../providers/database/database-provider';
import type { ModelProfiler } from '../dbt/model-profiler';

export interface ServiceContainerOptions {
	extensionContext: vscode.ExtensionContext;
	logger: ILogger;
	extensionVersion: string;
}

/**
 * Singleton service locator for the dbt Anvil extension.
 *
 * Holds the extension context and all lazily-initialized services.
 * Call ServiceContainer.initialize(options) from activate(), then
 * ServiceContainer.getInstance() anywhere.
 */
export class ServiceContainer {
	private static _instance: ServiceContainer | null = null;

	private readonly _context: vscode.ExtensionContext;
	private readonly _logger: ILogger;
	private readonly _version: string;

	// Lazily set by the extension bootstrapper
	private _bridgeRunner: BridgeRunner | null = null;
	private _databaseProvider: DatabaseProvider | null = null;
	private _manifestLoader: ManifestLoader | null = null;
	private _manifestIndexer: ManifestIndexer | null = null;
	private _manifestWatcher: IManifestSuppressor | null = null;
	private _executionService: DbtExecutionService | null = null;
	private _modelProfiler: ModelProfiler | null = null;

	private constructor(options: ServiceContainerOptions) {
		this._context = options.extensionContext;
		this._logger = options.logger;
		this._version = options.extensionVersion;
	}

	static initialize(options: ServiceContainerOptions): ServiceContainer {
		if (ServiceContainer._instance) {
			throw new Error('ServiceContainer is already initialized. Call reset() first.');
		}
		ServiceContainer._instance = new ServiceContainer(options);
		return ServiceContainer._instance;
	}

	static getInstance(): ServiceContainer {
		if (!ServiceContainer._instance) {
			throw new Error('ServiceContainer has not been initialized. Call initialize() first.');
		}
		return ServiceContainer._instance;
	}

	/** Useful in tests or on deactivate to reset the singleton. */
	static reset(): void {
		ServiceContainer._instance = null;
	}

	static isInitialized(): boolean {
		return ServiceContainer._instance !== null;
	}

	// -------------------------------------------------------------------------
	// Core accessors
	// -------------------------------------------------------------------------

	getExtensionContext(): vscode.ExtensionContext {
		return this._context;
	}

	getLogger(): ILogger {
		return this._logger;
	}

	getExtensionVersion(): string {
		return this._version;
	}

	// -------------------------------------------------------------------------
	// Service accessors — set externally during activate()
	// -------------------------------------------------------------------------

	setBridgeRunner(runner: BridgeRunner): void {
		this._bridgeRunner = runner;
	}

	getBridgeRunner(): BridgeRunner {
		if (!this._bridgeRunner) {
			throw new Error('BridgeRunner is not yet initialized.');
		}
		return this._bridgeRunner;
	}

	setManifestLoader(loader: ManifestLoader): void {
		this._manifestLoader = loader;
	}

	getManifestLoader(): ManifestLoader {
		if (!this._manifestLoader) {
			throw new Error('ManifestLoader is not yet initialized.');
		}
		return this._manifestLoader;
	}

	setManifestIndexer(indexer: ManifestIndexer): void {
		this._manifestIndexer = indexer;
	}

	getManifestIndexer(): ManifestIndexer {
		if (!this._manifestIndexer) {
			throw new Error('ManifestIndexer is not yet initialized.');
		}
		return this._manifestIndexer;
	}

	setManifestWatcher(watcher: IManifestSuppressor): void {
		this._manifestWatcher = watcher;
	}

	getManifestWatcher(): IManifestSuppressor | null {
		return this._manifestWatcher;
	}

	setExecutionService(service: DbtExecutionService): void {
		this._executionService = service;
	}

	getExecutionService(): DbtExecutionService {
		if (!this._executionService) {
			throw new Error('DbtExecutionService is not yet initialized.');
		}
		return this._executionService;
	}

	setDatabaseProvider(provider: DatabaseProvider): void {
		this._databaseProvider = provider;
	}

	getDatabaseProvider(): DatabaseProvider {
		if (!this._databaseProvider) {
			throw new Error('DatabaseProvider is not yet initialized.');
		}
		return this._databaseProvider;
	}

	setModelProfiler(profiler: ModelProfiler): void {
		this._modelProfiler = profiler;
	}

	getModelProfiler(): ModelProfiler {
		if (!this._modelProfiler) {
			throw new Error('ModelProfiler is not yet initialized.');
		}
		return this._modelProfiler;
	}
}
