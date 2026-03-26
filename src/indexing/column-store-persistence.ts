import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { ManifestIndexer } from './manifest-indexer';
import type { ILogger } from '../types/logger';

interface PersistedColumnStore {
	version: 1;
	columns: Record<string, string[]>;
	checksums: Record<string, string>;
}

const FILE_NAME = 'column-store.json';

/**
 * Persists the ManifestIndexer column store to VS Code workspace storage so
 * describe results survive extension restarts.  The saved checksums are seeded
 * back into the indexer BEFORE the first manifest build so that
 * _diffAndInvalidate can selectively evict only nodes that actually changed,
 * rather than clearing the entire store.
 */
export class ColumnStorePersistence {
	private readonly _filePath: string;

	constructor(
		context: vscode.ExtensionContext,
		private readonly logger: ILogger,
	) {
		// storageUri is workspace-scoped (different dbt projects → different caches)
		const storageDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
		this._filePath = path.join(storageDir, FILE_NAME);
	}

	/**
	 * Load persisted column data and seed it into the indexer.
	 * Must be called BEFORE the first manifestIndexer.build() so the diff logic
	 * can compare against saved checksums instead of treating everything as new.
	 */
	restore(indexer: ManifestIndexer): void {
		try {
			if (!fs.existsSync(this._filePath)) return;
			const raw = fs.readFileSync(this._filePath, 'utf8');
			const data = JSON.parse(raw) as PersistedColumnStore;
			if (data.version !== 1) return;
			indexer.seedFromCache({ columns: data.columns, checksums: data.checksums });
			this.logger.info(`ColumnStore: restored ${Object.keys(data.columns).length} entries from disk`);
		} catch (err) {
			this.logger.warn(`ColumnStore: failed to restore from disk: ${err}`);
		}
	}

	/**
	 * Snapshot the current column store to disk.  Called on manifest rebuild and
	 * on extension deactivation.
	 */
	save(indexer: ManifestIndexer): void {
		try {
			const data = indexer.exportForCache();
			if (Object.keys(data.columns).length === 0) return;
			fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
			const payload: PersistedColumnStore = { version: 1, ...data };
			fs.writeFileSync(this._filePath, JSON.stringify(payload), 'utf8');
			this.logger.debug(`ColumnStore: saved ${Object.keys(data.columns).length} entries to disk`);
		} catch (err) {
			this.logger.warn(`ColumnStore: failed to save to disk: ${err}`);
		}
	}
}
