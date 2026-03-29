import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { ILogger } from '../types/logger';

interface PersistedContentHashes {
	version: 1;
	hashes: Record<string, string>;
}

const FILE_NAME = 'content-hashes.json';

/**
 * Persists ManifestWatcher content hashes to VS Code workspace storage so the
 * first save after an extension restart does not falsely trigger a dbt parse
 * for files whose content has not changed.
 */
export class ContentHashPersistence {
	private readonly _filePath: string;

	constructor(
		context: vscode.ExtensionContext,
		private readonly logger: ILogger,
	) {
		const storageDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
		this._filePath = path.join(storageDir, FILE_NAME);
	}

	restore(): Record<string, string> {
		try {
			if (!fs.existsSync(this._filePath)) return {};
			const data = JSON.parse(fs.readFileSync(this._filePath, 'utf8')) as PersistedContentHashes;
			if (data.version !== 1) return {};
			this.logger.debug(`ContentHashes: restored ${Object.keys(data.hashes).length} entries from disk`);
			return data.hashes;
		} catch (err) {
			this.logger.warn(`ContentHashes: failed to restore from disk: ${err}`);
			return {};
		}
	}

	save(hashes: ReadonlyMap<string, string>): void {
		try {
			if (hashes.size === 0) return;
			fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
			const payload: PersistedContentHashes = { version: 1, hashes: Object.fromEntries(hashes) };
			fs.writeFileSync(this._filePath, JSON.stringify(payload), 'utf8');
			this.logger.debug(`ContentHashes: saved ${hashes.size} entries to disk`);
		} catch (err) {
			this.logger.warn(`ContentHashes: failed to save to disk: ${err}`);
		}
	}
}
