import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { ManifestLoader } from '../dbt/manifest-loader';
import { ManifestIndexer } from './manifest-indexer';

/**
 * Minimal interface required by DbtExecutionService and ExternalDbtMonitor to
 * suppress/resume manifest change handling around bridge commands that rewrite
 * manifest.json as a side effect (describe_table, show, etc.).
 */
export interface IManifestSuppressor {
	suppress(): void;
	resume(): void;
	triggerRebuild(): void;
}

/**
 * Watches the manifest.json path configured by ManifestLoader and rebuilds the index.
 * Also watches dbt_project.yml for project-level changes.
 * Watches SQL model files and invalidates column store entries on save.
 */
export class ManifestWatcher {
	private _manifestWatcher: vscode.FileSystemWatcher | null = null;
	private _sourceWatcher: vscode.FileSystemWatcher | null = null;
	private _projectDir: string | null = null;
	private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _parseDebounceTimer: ReturnType<typeof setTimeout> | null = null;
	private _suppressed = false;
	private readonly _contentHashes = new Map<string, string>();
	private readonly _nonWsHashes = new Map<string, string>();
	private readonly _onIndexRebuild = new vscode.EventEmitter<{ indexer: ManifestIndexer; pivots: vscode.Uri[] }>();
	private readonly _pendingPivots = new Set<vscode.Uri>();
	private readonly _onProjectConfigChanged = new vscode.EventEmitter<void>();
	private readonly _onParseRequested = new vscode.EventEmitter<void>();
	private readonly _onEnrichmentInvalidated = new vscode.EventEmitter<Set<string>>();
	private readonly _onCompileInvalidated = new vscode.EventEmitter<string>();

	readonly onIndexRebuild = this._onIndexRebuild.event;
	readonly onProjectConfigChanged = this._onProjectConfigChanged.event;
	/** Fires when an on-save model change should trigger a background dbt parse. */
	readonly onParseRequested = this._onParseRequested.event;
	/** Fires with the set of evicted unique IDs after column store invalidation. */
	readonly onEnrichmentInvalidated = this._onEnrichmentInvalidated.event;
	/** Fires with the unique ID of the saved model so its compile cache entry can be cleared. */
	readonly onCompileInvalidated = this._onCompileInvalidated.event;

	constructor(
		private readonly loader: ManifestLoader,
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	start(projectDir: string): void {
		this._projectDir = projectDir;
		this._startManifestWatcher();
		this._startSourceWatcher();
		this.logger.info('ManifestWatcher started');
	}

	/**
	 * Invalidation entry point for a single source file. Called from the
	 * project-scoped FileSystemWatcher on change/create. Reads the file from
	 * disk, dedups against the previous content hash, evicts column-store and
	 * compile-cache entries for the affected model, and queues a debounced
	 * dbt parse.
	 *
	 * Exposed for unit testing — the watcher's onDidChange/onDidCreate
	 * callbacks delegate here, so tests can drive the invalidation path
	 * directly without standing up a real FileSystemWatcher.
	 */
	handleSourceChange(absPath: string, uri: vscode.Uri): void {
		if (this._isExcludedPath(absPath)) return;
		if (!absPath.endsWith('.sql') && !absPath.endsWith('.yml') && !absPath.endsWith('.yaml')) return;

		// Skip if content hasn't changed since last invocation
		const prevHash = this._contentHashes.get(absPath);
		let currentHash: string;
		let content: string;
		try {
			content = fs.readFileSync(absPath, 'utf8');
			currentHash = this._simpleHash(content);
		} catch {
			return; // unreadable — bail rather than queue work on partial state
		}
		if (prevHash === currentHash) {
			this.logger.trace(`Source unchanged, skipping parse: ${absPath}`);
			return;
		}
		this._contentHashes.set(absPath, currentHash);

		// Skip parse if only whitespace changed — dbt parse is expensive
		const prevNonWsHash = this._nonWsHashes.get(absPath);
		const currentNonWsHash = this._simpleHash(content.replace(/\s+/g, ''));
		this._nonWsHashes.set(absPath, currentNonWsHash);
		if (prevNonWsHash === currentNonWsHash) {
			this.logger.trace(`Whitespace-only source change, skipping parse: ${absPath}`);
			return;
		}

		const uniqueId = this.indexer.findModelByFilePath(absPath);
		if (!uniqueId || uniqueId.startsWith('analysis.')) return; // not a project model — skip parse

		this._pendingPivots.add(uri);

		const evicted = this.indexer.invalidateModel(uniqueId);
		this._onCompileInvalidated.fire(uniqueId);
		if (evicted.size > 0) {
			this.logger.info(`Source changed: ${uniqueId} — evicted ${evicted.size} column store entries`);
			this._onEnrichmentInvalidated.fire(evicted);
		}
		this._debouncedParse();
	}

	private _isExcludedPath(absPath: string): boolean {
		if (!this._projectDir) return false;
		const norm = absPath.replace(/\\/g, '/').toLowerCase();
		const proj = this._projectDir.replace(/\\/g, '/').toLowerCase();
		// dbt rewrites compiled .sql files under target/ on every run — must not
		// trigger invalidation/parse cycles. Same for vendored packages.
		if (norm.startsWith(`${proj}/target/`)) return true;
		if (norm.startsWith(`${proj}/dbt_packages/`)) return true;
		if (norm.includes('/node_modules/')) return true;
		if (norm.includes('/.git/')) return true;
		return false;
	}

	/**
	 * Handle a dbt_project.yml change that was detected externally (e.g. by ManifestService
	 * via DbtProjectService.onProjectChanged). Reloads project config, fires onProjectConfigChanged,
	 * restarts the manifest file watcher (target path may have changed), and rebuilds.
	 */
	handleProjectConfigChanged(): void {
		this.loader.reloadProjectConfig();
		this._onProjectConfigChanged.fire();
		this._startManifestWatcher();
		this._rebuild('dbt_project.yml changed');
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
			const pivots = [...this._pendingPivots];
			this._pendingPivots.clear();
			this._onIndexRebuild.fire({ indexer: this.indexer, pivots });
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

	/**
	 * Force an immediate manifest index rebuild, bypassing debounce and suppression.
	 * Call this after an external dbt command (run/build/seed etc.) completes in a terminal
	 * so the extension picks up any manifest changes it wrote.
	 */
	triggerRebuild(): void {
		this._rebuild('external dbt command completed');
	}

	private _debouncedParse(): void {
		if (this._parseDebounceTimer) clearTimeout(this._parseDebounceTimer);
		this._parseDebounceTimer = setTimeout(() => {
			this._parseDebounceTimer = null;
			this._triggerBackgroundParse();
		}, 1000);
	}

	private _triggerBackgroundParse(): void {
		this._onParseRequested.fire();
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

	private _startManifestWatcher(): void {
		this._manifestWatcher?.dispose();
		const manifestUri = vscode.Uri.file(this.loader.manifestPath);
		this._manifestWatcher = vscode.workspace.createFileSystemWatcher(manifestUri.fsPath);
		this._manifestWatcher.onDidChange(() => this._debouncedRebuild('manifest changed'));
		this._manifestWatcher.onDidCreate(() => this._debouncedRebuild('manifest created'));
	}

	/**
	 * Watch project-scoped source files (.sql/.yml/.yaml) for disk-level
	 * changes. Replaces the previous onDidSaveTextDocument-only path, which
	 * missed every write that did not originate from a VS Code editor save —
	 * external tools, agent file writes, branch switches, formatters.
	 */
	private _startSourceWatcher(): void {
		this._sourceWatcher?.dispose();
		if (!this._projectDir) return;
		const pattern = new vscode.RelativePattern(this._projectDir, '**/*.{sql,yml,yaml}');
		this._sourceWatcher = vscode.workspace.createFileSystemWatcher(pattern);
		this._sourceWatcher.onDidChange((uri) => this.handleSourceChange(uri.fsPath, uri));
		this._sourceWatcher.onDidCreate((uri) => this.handleSourceChange(uri.fsPath, uri));
		this._sourceWatcher.onDidDelete((uri) => {
			if (this._isExcludedPath(uri.fsPath)) return;
			this._debouncedParse();
		});
	}

	dispose(): void {
		if (this._debounceTimer) {
			clearTimeout(this._debounceTimer);
		}
		if (this._parseDebounceTimer) {
			clearTimeout(this._parseDebounceTimer);
		}
		this._manifestWatcher?.dispose();
		this._sourceWatcher?.dispose();
		this._onIndexRebuild.dispose();
		this._onParseRequested.dispose();
		this._onEnrichmentInvalidated.dispose();
		this._onCompileInvalidated.dispose();
	}
}
