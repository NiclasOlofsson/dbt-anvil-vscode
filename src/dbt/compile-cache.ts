import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ILogger } from '../types/logger';
import type { DbtExecutionService } from './execution-service';
import { Priority } from './execution-service';
import type { ManifestLoader } from './manifest-loader';

interface CacheEntry {
	compiledCode: string;
	/** mtime of the source SQL file at time of compilation */
	sourceMtimeMs: number;
	/** djb2 content hash of the source SQL file at time of compilation */
	sourceContentHash: string;
	/** relative path from project root (original_file_path from manifest) */
	originalFilePath: string;
}

/**
 * Shared in-memory cache for compiled_code, keyed by model unique_id.
 *
 * Problem solved: `dbt compile -s <model>` rewrites the full manifest, placing
 * compiled_code only for the selected model and wiping it for all others. Without
 * a cache, every tool call that needs compiled SQL triggers a redundant compile.
 *
 * Strategy:
 * - Before compiling, check if we have a cached entry whose source-file mtime
 *   matches the current file on disk. If so, return immediately — no subprocess.
 * - After a compile succeeds, read the manifest directly and cache compiled_code
 *   for ALL nodes that have it. This means one compile populates the cache for
 *   every model dbt happened to compile (e.g. when compiling without -s selector
 *   all models are populated at once).
 * - Cache is invalidated per-model when the source file timestamp changes
 *   (detected on next request) or when invalidate() is called explicitly.
 */
export class CompileCache {
	private readonly _cache = new Map<string, CacheEntry>();
	private readonly _inflight = new Map<string, Promise<string | undefined>>();

	constructor(
		private readonly service: DbtExecutionService,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	/**
	 * Return compiled_code for the given model, compiling if necessary.
	 * `uniqueId`   — dbt unique_id (e.g. "model.jaffle_shop.customers")
	 * `modelName`  — short model name used as dbt -s selector
	 * `projectDir` — project root, used to resolve original_file_path
	 * `originalFilePath` — relative path from manifest (original_file_path field)
	 */
	async ensureCompiled(
		uniqueId: string,
		modelName: string,
		projectDir: string,
		originalFilePath: string,
	): Promise<string | undefined> {
		const absPath = path.join(projectDir, originalFilePath);
		const currentMtime = this._fileMtime(absPath);

		// Cache hit — source file unchanged
		const cached = this._cache.get(uniqueId);
		if (cached && currentMtime !== undefined) {
			if (cached.sourceMtimeMs === currentMtime) {
				this.logger.trace(`CompileCache: hit for ${uniqueId} (mtime)`);
				return cached.compiledCode;
			}
			// mtime changed — check content hash before declaring a miss
			const currentHash = this._fileHash(absPath);
			if (currentHash !== undefined && currentHash === cached.sourceContentHash) {
				this._cache.set(uniqueId, { ...cached, sourceMtimeMs: currentMtime });
				this.logger.trace(`CompileCache: hit for ${uniqueId} (content hash, mtime updated)`);
				return cached.compiledCode;
			}
		}

		// Warm path — compiled_code already in the manifest (e.g. after full `dbt compile`).
		// Cache it so it survives a subsequent per-model compile that would wipe the manifest entry.
		const { manifest } = this.loader.load();
		const manifestNode = manifest.nodes[uniqueId];
		if (manifestNode?.compiled_code) {
			const hash = this._fileHash(absPath);
			if (currentMtime !== undefined && hash !== undefined) {
				this._cache.set(uniqueId, {
					compiledCode: manifestNode.compiled_code,
					sourceMtimeMs: currentMtime,
					sourceContentHash: hash,
					originalFilePath,
				});
			}
			this.logger.trace(`CompileCache: warm from manifest for ${uniqueId}`);
			return manifestNode.compiled_code;
		}

		this.logger.trace(`CompileCache: miss for ${uniqueId}, compiling`);

		// Deduplicate concurrent compile requests for the same model
		const existing = this._inflight.get(uniqueId);
		if (existing) {
			this.logger.trace(`CompileCache: awaiting inflight compile for ${uniqueId}`);
			return existing;
		}

		const promise = this._compile(uniqueId, modelName, projectDir);
		this._inflight.set(uniqueId, promise);
		try {
			return await promise;
		} finally {
			this._inflight.delete(uniqueId);
		}
	}

	private async _compile(
		uniqueId: string,
		modelName: string,
		projectDir: string,
	): Promise<string | undefined> {
		// Run dbt compile for this model
		try {
			const result = await this.service.submit({
				type: 'compile',
				args: ['compile', '-s', modelName],
				priority: Priority.Tool,
				origin: 'copilot',
				label: `compile ${modelName}`,
			});

			if (!result.success) {
				this.logger.warn(`CompileCache: compile failed for ${modelName}`);
				return undefined;
			}
		} catch (err) {
			this.logger.warn(`CompileCache: compile error for ${modelName}: ${err}`);
			return undefined;
		}

		// Read the fresh manifest directly from disk and populate cache for ALL compiled nodes
		this._populateCacheFromManifest(projectDir);

		// Return from newly populated cache
		const entry = this._cache.get(uniqueId);
		return entry?.compiledCode;
	}

	/**
	 * Run a full `dbt compile` in the background to pre-populate the cache for
	 * all models at once. This is much faster than compiling models individually
	 * on first request, since there is only one subprocess startup overhead.
	 *
	 * If `minCachedEntries` is provided and the cache already holds at least that
	 * many valid entries (restored from disk), the compile is skipped entirely.
	 *
	 * Safe to call fire-and-forget — errors are logged, not thrown.
	 */
	async warmAll(projectDir: string, minCachedEntries = 0): Promise<void> {
		if (minCachedEntries > 0 && this._cache.size >= minCachedEntries) {
			this.logger.info(`CompileCache: ${this._cache.size} entries already cached — skipping warm compile`);
			return;
		}
		this.logger.info('CompileCache: starting background full compile to warm cache');
		try {
			const result = await this.service.submit({
				type: 'compile',
				args: ['compile'],
				priority: Priority.User,
				origin: 'background',
				label: 'compile (warm cache)',
			});
			if (!result.success) {
				this.logger.warn('CompileCache: background full compile failed — cache not warmed');
				return;
			}
			this._populateCacheFromManifest(projectDir);
			this.logger.info('CompileCache: background full compile complete — cache warmed');
		} catch (err) {
			this.logger.warn(`CompileCache: background full compile error: ${err}`);
		}
	}

	/**
	 * Seed the in-memory cache from persisted data. Each entry's mtime is checked
	 * first (fast path); if the mtime changed, the content hash is checked — if
	 * content is unchanged the entry is accepted with the updated mtime. Entries
	 * whose content has changed are dropped. Returns the count of valid entries.
	 */
	seedFromPersisted(
		entries: Record<string, { compiledCode: string; sourceMtimeMs: number; sourceContentHash: string; originalFilePath: string }>,
		projectDir: string,
	): number {
		let loaded = 0;
		for (const [uid, entry] of Object.entries(entries)) {
			const absPath = path.join(projectDir, entry.originalFilePath);
			const currentMtime = this._fileMtime(absPath);
			if (currentMtime === undefined) continue; // file gone
			if (currentMtime === entry.sourceMtimeMs) {
				this._cache.set(uid, entry);
				loaded++;
				continue;
			}
			// mtime changed — verify content before accepting
			const currentHash = this._fileHash(absPath);
			if (currentHash !== undefined && currentHash === entry.sourceContentHash) {
				this._cache.set(uid, { ...entry, sourceMtimeMs: currentMtime });
				loaded++;
			}
			// else: content changed — drop entry
		}
		return loaded;
	}

	/**
	 * Return the cached compiled SQL for a uniqueId without triggering a compile.
	 * Returns undefined if the model has not been compiled yet in this session.
	 */
	getCachedSql(uniqueId: string): string | undefined {
		return this._cache.get(uniqueId)?.compiledCode;
	}

	/**
	 * Export all current cache entries for persistence.
	 */
	exportForPersistence(): Record<string, { compiledCode: string; sourceMtimeMs: number; sourceContentHash: string; originalFilePath: string }> {
		return Object.fromEntries(this._cache);
	}

	/**
	 * Explicitly invalidate the cache entry for a model (e.g. on SQL file save).
	 * Accepts either a unique_id or a short model name.
	 */
	invalidate(uniqueIdOrName: string): void {
		if (this._cache.delete(uniqueIdOrName)) {
			this.logger.trace(`CompileCache: invalidated ${uniqueIdOrName}`);
			return;
		}
		// Name-based fallback
		for (const key of this._cache.keys()) {
			if (key.endsWith(`.${uniqueIdOrName}`)) {
				this._cache.delete(key);
				this.logger.trace(`CompileCache: invalidated by name ${uniqueIdOrName} (key=${key})`);
				return;
			}
		}
	}

	/**
	 * Read the manifest from disk and populate the cache for every node that
	 * has compiled_code. Called after a successful compile to warm the cache.
	 */
	private _populateCacheFromManifest(projectDir: string): void {
		try {
			const { manifest } = this.loader.load(true);
			let count = 0;
			for (const node of Object.values(manifest.nodes)) {
				if (!node.compiled_code) continue;
				const absPath = path.join(projectDir, node.original_file_path);
				const mtime = this._fileMtime(absPath);
				if (mtime === undefined) continue;
				const hash = this._fileHash(absPath);
				if (hash === undefined) continue;
				this._cache.set(node.unique_id, {
					compiledCode: node.compiled_code,
					sourceMtimeMs: mtime,
					sourceContentHash: hash,
					originalFilePath: node.original_file_path,
				});
				count++;
			}
			this.logger.trace(`CompileCache: populated ${count} entries from manifest`);
		} catch (err) {
			this.logger.warn(`CompileCache: failed to read manifest: ${err}`);
		}
	}

	private _fileMtime(absPath: string): number | undefined {
		try {
			return fs.statSync(absPath).mtimeMs;
		} catch {
			return undefined;
		}
	}

	/** djb2-variant hash of file content, returned as a base-36 string. */
	private _fileHash(absPath: string): string | undefined {
		try {
			const content = fs.readFileSync(absPath, 'utf8');
			let hash = 5381;
			for (let i = 0; i < content.length; i++) {
				hash = Math.imul(hash, 33) ^ content.charCodeAt(i);
			}
			return (hash >>> 0).toString(36);
		} catch {
			return undefined;
		}
	}
}
