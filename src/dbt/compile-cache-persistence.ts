import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { CompileCache } from './compile-cache';
import type { ILogger } from '../types/logger';

interface PersistedEntry {
	compiledCode: string;
	sourceMtimeMs: number;
	sourceContentHash: string;
	originalFilePath: string;
}

interface PersistedCompileCache {
	version: 2;
	entries: Record<string, PersistedEntry>;
}

const FILE_NAME = 'compile-cache.json';

/**
 * Persists CompileCache entries to VS Code workspace storage so compiled SQL
 * survives extension restarts.  On restore, each entry's sourceMtimeMs is
 * checked against the current file on disk — stale entries are silently dropped.
 * If enough valid entries are restored, warmAll() is skipped at startup.
 */
export class CompileCachePersistence {
	private readonly _filePath: string;

	constructor(
		context: vscode.ExtensionContext,
		private readonly logger: ILogger,
	) {
		const storageDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
		this._filePath = path.join(storageDir, FILE_NAME);
	}

	/**
	 * Load persisted entries, validate each entry against the file on disk
	 * (mtime first, content hash as fallback), and seed the cache.
	 * Returns the number of valid entries restored.
	 */
	restore(cache: CompileCache, projectDir: string): number {
		try {
			if (!fs.existsSync(this._filePath)) return 0;
			const raw = fs.readFileSync(this._filePath, 'utf8');
			const data = JSON.parse(raw) as PersistedCompileCache;
			if (data.version !== 2) return 0;
			const loaded = cache.seedFromPersisted(data.entries, projectDir);
			this.logger.info(`CompileCache: restored ${loaded} entries from disk`);
			return loaded;
		} catch (err) {
			this.logger.warn(`CompileCache: failed to restore from disk: ${err}`);
			return 0;
		}
	}

	/**
	 * Snapshot current cache entries to disk.
	 */
	save(cache: CompileCache): void {
		try {
			const entries = cache.exportForPersistence();
			if (Object.keys(entries).length === 0) return;
			fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
			const payload: PersistedCompileCache = { version: 2, entries };
			fs.writeFileSync(this._filePath, JSON.stringify(payload), 'utf8');
			this.logger.debug(`CompileCache: saved ${Object.keys(entries).length} entries to disk`);
		} catch (err) {
			this.logger.warn(`CompileCache: failed to save to disk: ${err}`);
		}
	}

	/** Delete the persisted cache file from disk. */
	clear(): void {
		try {
			if (fs.existsSync(this._filePath)) {
				fs.unlinkSync(this._filePath);
				this.logger.info('CompileCache: cleared persisted cache from disk');
			}
		} catch (err) {
			this.logger.warn(`CompileCache: failed to clear persisted cache: ${err}`);
		}
	}
}
