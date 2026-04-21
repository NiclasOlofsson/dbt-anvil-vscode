import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as vscode from 'vscode';
import type { ILogger } from '../../types/logger';
import type { PersistedWorkspaceScannerSnapshot } from './scanner';

const FILE_NAME = 'workspace-ninja-diagnostics.json';

/**
 * Persists WorkspaceDiagnosticsScanner state to extension storage so Ninja
 * diagnostics can be restored instantly on startup and only changed files are re-scanned.
 */
export class WorkspaceDiagnosticsPersistence {
	private readonly _filePath: string;

	constructor(
		context: vscode.ExtensionContext,
		private readonly logger: ILogger,
	) {
		const storageDir = context.storageUri?.fsPath ?? context.globalStorageUri.fsPath;
		this._filePath = path.join(storageDir, FILE_NAME);
	}

	restore(): PersistedWorkspaceScannerSnapshot | undefined {
		try {
			if (!fs.existsSync(this._filePath)) return undefined;
			const raw = fs.readFileSync(this._filePath, 'utf8');
			const data = JSON.parse(raw) as PersistedWorkspaceScannerSnapshot;
			if (data.version !== 1) return undefined;
			this.logger.debug(`WorkspaceNinja: restored ${Object.keys(data.entries).length} scanner entries from disk`);
			return data;
		} catch (err) {
			this.logger.warn(`WorkspaceNinja: failed to restore from disk: ${err}`);
			return undefined;
		}
	}

	save(snapshot: PersistedWorkspaceScannerSnapshot): void {
		try {
			fs.mkdirSync(path.dirname(this._filePath), { recursive: true });
			fs.writeFileSync(this._filePath, JSON.stringify(snapshot), 'utf8');
			this.logger.debug(`WorkspaceNinja: saved ${Object.keys(snapshot.entries).length} scanner entries to disk`);
		} catch (err) {
			this.logger.warn(`WorkspaceNinja: failed to save to disk: ${err}`);
		}
	}
}
