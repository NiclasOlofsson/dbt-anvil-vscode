import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { DbtProjectService } from '../dbt/dbt-project-service';
import { ManifestLoader } from '../dbt/manifest-loader';
import { ManifestIndexer } from './manifest-indexer';
import { ManifestWatcher } from './manifest-watcher';
import type { IManifestSuppressor } from './manifest-watcher';

/**
 * Consolidation façade for ManifestLoader + ManifestIndexer + ManifestWatcher.
 *
 * Owns the construction of all three objects and wires them together.
 * In extension.ts, replace the three separate constructions with a single ManifestService.
 *
 * Implements IManifestSuppressor so DbtExecutionService can suppress/resume via this object.
 */
export class ManifestService implements vscode.Disposable, IManifestSuppressor {
	readonly loader: ManifestLoader;
	readonly indexer: ManifestIndexer;
	private readonly watcher: ManifestWatcher;
	private _projectChangedDisposable: vscode.Disposable | null = null;

	readonly onIndexRebuild: vscode.Event<{ indexer: ManifestIndexer; pivots: vscode.Uri[] }>;
	readonly onProjectConfigChanged: vscode.Event<void>;
	readonly onParseRequested: vscode.Event<void>;
	readonly onEnrichmentInvalidated: vscode.Event<Set<string>>;
	readonly onCompileInvalidated: vscode.Event<string>;

	constructor(
		private readonly projectService: DbtProjectService,
		extensionTargetDir: string | undefined,
		private readonly logger: ILogger,
	) {
		this.loader = new ManifestLoader(projectService.projectDir, extensionTargetDir);
		this.indexer = new ManifestIndexer(this.loader, logger);
		this.watcher = new ManifestWatcher(this.loader, this.indexer, logger);

		this.onIndexRebuild = this.watcher.onIndexRebuild;
		this.onProjectConfigChanged = this.watcher.onProjectConfigChanged;
		this.onParseRequested = this.watcher.onParseRequested;
		this.onEnrichmentInvalidated = this.watcher.onEnrichmentInvalidated;
		this.onCompileInvalidated = this.watcher.onCompileInvalidated;
	}

	/** Start file watchers. Call once after construction. */
	start(): void {
		this.watcher.start(this.projectService.projectDir);
		this._projectChangedDisposable = this.projectService.onProjectChanged(() => {
			this.watcher.handleProjectConfigChanged();
		});
	}

	suppress(): void {
		this.watcher.suppress();
	}

	resume(): void {
		this.watcher.resume();
	}

	triggerRebuild(): void {
		this.watcher.triggerRebuild();
	}

	restoreHashes(persisted: { hashes: Record<string, string>; nonWsHashes: Record<string, string> }): void {
		this.watcher.restoreHashes(persisted);
	}

	getHashes(): { hashes: ReadonlyMap<string, string>; nonWsHashes: ReadonlyMap<string, string> } {
		return this.watcher.getHashes();
	}

	manifestExists(): boolean {
		return this.loader.manifestExists();
	}

	getDbtVersion(): string | undefined {
		return this.loader.getDbtVersion();
	}

	dispose(): void {
		this._projectChangedDisposable?.dispose();
		this.watcher.dispose();
	}
}
