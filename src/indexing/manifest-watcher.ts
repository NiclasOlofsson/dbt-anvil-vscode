import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { ManifestLoader } from '../dbt/manifest-loader';
import { ManifestIndexer } from './manifest-indexer';

/**
 * Watches dbt target/manifest.json for changes and rebuilds the index.
 * Also watches dbt_project.yml for project-level changes.
 * Watches SQL model files and invalidates column store entries on save.
 */
export class ManifestWatcher {
	private _manifestWatcher: vscode.FileSystemWatcher | null = null;
	private _projectWatcher: vscode.FileSystemWatcher | null = null;
	private _sqlSaveDisposable: vscode.Disposable | null = null;
	private readonly _onIndexRebuild = new vscode.EventEmitter<ManifestIndexer>();

	readonly onIndexRebuild = this._onIndexRebuild.event;

	constructor(
		private readonly loader: ManifestLoader,
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	start(projectDir: string): void {
		const manifestPattern = new vscode.RelativePattern(projectDir, '**/target/manifest.json');
		this._manifestWatcher = vscode.workspace.createFileSystemWatcher(manifestPattern);

		this._manifestWatcher.onDidChange(() => this._rebuild('manifest changed'));
		this._manifestWatcher.onDidCreate(() => this._rebuild('manifest created'));

		const projectPattern = new vscode.RelativePattern(projectDir, 'dbt_project.yml');
		this._projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);
		this._projectWatcher.onDidChange(() => {
			this.loader.reloadProjectConfig();
			this._rebuild('dbt_project.yml changed');
		});

		// Invalidate column store entries when a SQL model file is saved
		this._sqlSaveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
			if (doc.languageId !== 'jinja-sql' && !doc.fileName.endsWith('.sql')) return;
			const uniqueId = this.indexer.findModelByFilePath(doc.fileName);
			if (uniqueId) {
				const evicted = this.indexer.invalidateModel(uniqueId);
				if (evicted.size > 0) {
					this.logger.info(`Model saved: ${uniqueId} — evicted ${evicted.size} column store entries`);
				}
			}
		});

		this.logger.info('ManifestWatcher started');
	}

	private _rebuild(reason: string): void {
		this.logger.info(`Rebuilding manifest index (${reason})`);
		try {
			this.loader.invalidate();
			this.indexer.build(true);
			this._onIndexRebuild.fire(this.indexer);
		} catch (err) {
			this.logger.warn(`Failed to rebuild manifest index: ${err}`);
		}
	}

	dispose(): void {
		this._manifestWatcher?.dispose();
		this._projectWatcher?.dispose();
		this._sqlSaveDisposable?.dispose();
		this._onIndexRebuild.dispose();
	}
}
