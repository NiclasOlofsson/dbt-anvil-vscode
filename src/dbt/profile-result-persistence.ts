import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { ProfileResult } from './profiler-types';
import type { ILogger } from '../types/logger';

interface PersistedProfileResults {
	version: 2;
	/** keyed by model uniqueId */
	results: Record<string, ProfileResult>;
}

const FILE_NAME = 'profile-results.json';
const SAVEABLE_STATUSES = new Set<ProfileResult['status']>(['complete', 'partial']);

/**
 * Persists the last profile result per model to VS Code workspace storage so
 * the profile tree and inline decorations survive extension restarts.
 * Only `complete` and `partial` results are saved — `running` and `error` are skipped.
 */
export class ProfileResultPersistence {
	private readonly _filePath: string;

	constructor(
		context: vscode.ExtensionContext,
		private readonly logger: ILogger,
	) {
		const storageDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
		this._filePath = path.join(storageDir, FILE_NAME);
	}

	/**
	 * Load persisted results and return them as a map keyed by uniqueId.
	 */
	restore(): Map<string, ProfileResult> {
		try {
			if (!fs.existsSync(this._filePath)) return new Map();
			const raw = fs.readFileSync(this._filePath, 'utf8');
			const data = JSON.parse(raw) as PersistedProfileResults;
			if (data.version !== 2) return new Map();
			const map = new Map(Object.entries(data.results));
			this.logger.info(`ProfileResults: restored ${map.size} result(s) from disk`);
			return map;
		} catch (err) {
			this.logger.warn(`ProfileResults: failed to restore from disk: ${err}`);
			return new Map();
		}
	}

	/**
	 * Snapshot all saveable results to disk.
	 */
	save(results: Map<string, ProfileResult>): void {
		try {
			const saveable: Record<string, ProfileResult> = {};
			for (const [id, result] of results) {
				if (SAVEABLE_STATUSES.has(result.status)) {
					saveable[id] = result;
				}
			}
			if (Object.keys(saveable).length === 0) return;
			fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
			const payload: PersistedProfileResults = { version: 2, results: saveable };
			fs.writeFileSync(this._filePath, JSON.stringify(payload), 'utf8');
			this.logger.debug(`ProfileResults: saved ${Object.keys(saveable).length} result(s) to disk`);
		} catch (err) {
			this.logger.warn(`ProfileResults: failed to save to disk: ${err}`);
		}
	}
}
