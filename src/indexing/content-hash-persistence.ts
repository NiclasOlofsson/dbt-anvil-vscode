import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { ILogger } from '../types/logger';

interface PersistedContentHashes {
	version: 2;
	hashes: Record<string, string>;
	nonWsHashes: Record<string, string>;
}

interface PersistedContentHashesV1 {
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

	restore(): { hashes: Record<string, string>; nonWsHashes: Record<string, string> } {
		try {
			if (!fs.existsSync(this._filePath)) return { hashes: {}, nonWsHashes: {} };
			const data = JSON.parse(fs.readFileSync(this._filePath, 'utf8')) as PersistedContentHashes | PersistedContentHashesV1;
			if (data.version === 1) {
				this.logger.debug(`ContentHashes: restored ${Object.keys(data.hashes).length} entries (v1, no nonWsHashes) from disk`);
				return { hashes: data.hashes, nonWsHashes: {} };
			}
			if (data.version !== 2) return { hashes: {}, nonWsHashes: {} };
			this.logger.debug(`ContentHashes: restored ${Object.keys(data.hashes).length} entries from disk`);
			return { hashes: data.hashes, nonWsHashes: data.nonWsHashes };
		} catch (err) {
			this.logger.warn(`ContentHashes: failed to restore from disk: ${err}`);
			return { hashes: {}, nonWsHashes: {} };
		}
	}

	save(hashes: ReadonlyMap<string, string>, nonWsHashes: ReadonlyMap<string, string>): void {
		try {
			if (hashes.size === 0) return;
			fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
			const payload: PersistedContentHashes = { version: 2, hashes: Object.fromEntries(hashes), nonWsHashes: Object.fromEntries(nonWsHashes) };
			fs.writeFileSync(this._filePath, JSON.stringify(payload), 'utf8');
			this.logger.debug(`ContentHashes: saved ${hashes.size} entries to disk`);
		} catch (err) {
			this.logger.warn(`ContentHashes: failed to save to disk: ${err}`);
		}
	}
}
