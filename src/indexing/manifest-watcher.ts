import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { DbtExecutionService } from '../dbt/execution-service';
import { Priority } from '../dbt/execution-service';
import { ManifestLoader } from '../dbt/manifest-loader';
import { ManifestIndexer } from './manifest-indexer';
import type { ParseService } from '../services/parse-service';
import type { CompileCache } from '../dbt/compile-cache';

/**
 * Watches dbt target/manifest.json for changes and rebuilds the index.
 * Also watches dbt_project.yml for project-level changes.
 * Watches SQL model files and invalidates column store entries on save.
 */
export class ManifestWatcher {
	private _manifestWatcher: vscode.FileSystemWatcher | null = null;
	private _projectWatcher: vscode.FileSystemWatcher | null = null;
	private _sqlSaveDisposable: vscode.Disposable | null = null;
	private _projectDir: string | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _parseDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _suppressed = false;
	private _executionService: DbtExecutionService | null = null;
	private _parseService: ParseService | null = null;
	private _compileCache: CompileCache | null = null;
	private readonly _contentHashes = new Map<string, string>();
	private readonly _nonWsHashes = new Map<string, string>();
	private readonly _onIndexRebuild = new vscode.EventEmitter<ManifestIndexer>();
	private readonly _onProjectConfigChanged = new vscode.EventEmitter<void>();

	readonly onIndexRebuild = this._onIndexRebuild.event;
	readonly onProjectConfigChanged = this._onProjectConfigChanged.event;

	constructor(
		private readonly loader: ManifestLoader,
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	start(projectDir: string): void {
		this._projectDir = projectDir;
		const manifestPattern = new vscode.RelativePattern(projectDir, '**/target/manifest.json');
		this._manifestWatcher = vscode.workspace.createFileSystemWatcher(manifestPattern);

		this._manifestWatcher.onDidChange(() => this._debouncedRebuild('manifest changed'));
		this._manifestWatcher.onDidCreate(() => this._debouncedRebuild('manifest created'));

		const projectPattern = new vscode.RelativePattern(projectDir, 'dbt_project.yml');
		this._projectWatcher = vscode.workspace.createFileSystemWatcher(projectPattern);
		this._projectWatcher.onDidChange(() => {
			this.loader.reloadProjectConfig();
			this._onProjectConfigChanged.fire();
			this._rebuild('dbt_project.yml changed');
		});

		// Invalidate column store entries when a SQL model file is saved
		this._sqlSaveDisposable = vscode.workspace.onDidSaveTextDocument((doc) => {
			if (doc.languageId !== 'jinja-sql' && !doc.fileName.endsWith('.sql')
				&& !doc.fileName.endsWith('.yml') && !doc.fileName.endsWith('.yaml')) return;

			// Skip if content hasn't changed since last save
			const prevHash = this._contentHashes.get(doc.fileName);
			let currentHash: string;
			let content: string;
			try {
				content = fs.readFileSync(doc.fileName, 'utf8');
				currentHash = this._simpleHash(content);
			} catch {
				return; // unreadable — let parse proceed
			}
			if (prevHash === currentHash) {
				this.logger.trace(`Save without content change, skipping parse: ${doc.fileName}`);
				return;
			}
			this._contentHashes.set(doc.fileName, currentHash);

			// Skip parse if only whitespace changed — dbt parse is expensive
			const prevNonWsHash = this._nonWsHashes.get(doc.fileName);
			const currentNonWsHash = this._simpleHash(content.replace(/\s+/g, ''));
			this._nonWsHashes.set(doc.fileName, currentNonWsHash);
			if (prevNonWsHash === currentNonWsHash) {
				this.logger.trace(`Save with whitespace-only change, skipping parse: ${doc.fileName}`);
				return;
			}

			const uniqueId = this.indexer.findModelByFilePath(doc.fileName);
			if (!uniqueId || uniqueId.startsWith('analysis.')) return; // not a project model — skip parse

			const evicted = this.indexer.invalidateModel(uniqueId);
			// Invalidate compile cache for the saved model
			this._compileCache?.invalidate(uniqueId);
			if (evicted.size > 0) {
				this.logger.info(`Model saved: ${uniqueId} — evicted ${evicted.size} column store entries`);
				// Surgical enrichment invalidation: only clear aliases for
				// documents that reference evicted nodes, not all documents.
				this._parseService?.invalidateEnrichmentFor(evicted);
			}
			this._debouncedParse();
		});

		this.logger.info('ManifestWatcher started');
	}

	private _debouncedRebuild(reason: string): void {
		if (this._suppressed) {
			this.logger.trace(`Manifest watcher suppressed, ignoring: ${reason}`);
			return;
		}
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		this._debounceTimer = setTimeout(() => {
			this._debounceTimer = null;
			this._rebuild(reason);
		}, 500);
	}

	private _rebuild(reason: string): void {
		this.logger.info(`Rebuilding manifest index (${reason})`);
		try {
			this.indexer.build(true);
			this._onIndexRebuild.fire(this.indexer);
			if (this._projectDir) this._populateHashesFromManifest(this._projectDir);
		} catch (err) {
			this.logger.warn(`Failed to rebuild manifest index: ${err}`);
		}
	}

	/**
	 * Suppress manifest change handling. Use when running bridge commands
	 * (like describe_table) that rewrite manifest.json as a side effect
	 * but don't actually change model definitions.
	 */
	suppress(): void {
		this._suppressed = true;
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
			this._debounceTimer = null;
		}
	}

	/**
	 * Resume manifest change handling after a suppressed operation.
	 * Does NOT trigger a rebuild — the suppressed changes are discarded.
	 */
	resume(): void {
		this._suppressed = false;
	}

	setExecutionService(service: DbtExecutionService): void {
		this._executionService = service;
	}

	setParseService(service: ParseService): void {
		this._parseService = service;
	}

	setCompileCache(cache: CompileCache): void {
		this._compileCache = cache;
	}

	private _debouncedParse(): void {
		if (this._parseDebounceTimer) clearTimeout(this._parseDebounceTimer);
		this._parseDebounceTimer = setTimeout(() => {
			this._parseDebounceTimer = null;
			this._triggerBackgroundParse();
		}, 1000);
	}

	private _triggerBackgroundParse(): void {
		if (!this._executionService) return;
		this._executionService.submit({
			type: 'parse',
			args: ['parse'],
			priority: Priority.Background,
			origin: 'background',
			label: 'parse (on save)',
		}).catch(() => {
			// Superseded or cancelled — that's fine
		});
	}

	/**
	 * Walk the manifest and populate content hashes for all model/source files
	 * not already tracked. This ensures that after a parse, the first auto-save
	 * of any file does not falsely trigger another parse.
	 */
	private _populateHashesFromManifest(projectDir: string): void {
		try {
			const { manifest } = this.loader.load();
			let added = 0;
			for (const node of Object.values(manifest.nodes)) {
				const absPath = path.join(projectDir, node.original_file_path);
				if (this._contentHashes.has(absPath)) continue;
				try {
					const src = fs.readFileSync(absPath, 'utf8');
					this._contentHashes.set(absPath, this._simpleHash(src));
					this._nonWsHashes.set(absPath, this._simpleHash(src.replace(/\s+/g, '')));
					added++;
				} catch {
					// file unreadable — skip
				}
			}
			if (added > 0) this.logger.debug(`ManifestWatcher: populated ${added} content hashes from manifest`);
		} catch (err) {
			this.logger.warn(`ManifestWatcher: failed to populate hashes from manifest: ${err}`);
		}
	}

	/** Fast non-cryptographic hash for content-change detection. */
	private _simpleHash(s: string): string {
		let h = 0;
		for (let i = 0; i < s.length; i++) {
			h = ((h << 5) - h + s.charCodeAt(i)) | 0;
		}
		return h.toString(36);
	}

	/**
	 * Seed content hashes from a previously persisted snapshot so that the
	 * first save after a restart does not falsely trigger a dbt parse.
	 */
	restoreHashes(persisted: { hashes: Record<string, string>; nonWsHashes: Record<string, string> }): void {
		for (const [fileName, hash] of Object.entries(persisted.hashes)) {
			this._contentHashes.set(fileName, hash);
		}
		for (const [fileName, hash] of Object.entries(persisted.nonWsHashes)) {
			this._nonWsHashes.set(fileName, hash);
		}
		this.logger.debug(`ManifestWatcher: restored ${Object.keys(persisted.hashes).length} content hashes`);
	}

	/** Returns the current content hash maps for persistence. */
	getHashes(): { hashes: ReadonlyMap<string, string>; nonWsHashes: ReadonlyMap<string, string> } {
		return { hashes: this._contentHashes, nonWsHashes: this._nonWsHashes };
	}

	dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		if (this._parseDebounceTimer) {
			clearTimeout(this._parseDebounceTimer);
		}
		this._manifestWatcher?.dispose();
		this._projectWatcher?.dispose();
		this._sqlSaveDisposable?.dispose();
		this._onIndexRebuild.dispose();
	}
}
