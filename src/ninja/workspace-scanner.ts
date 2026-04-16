import * as crypto from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import type { DbtPathResolver } from '../dbt/dbt-path-resolver';

/**
 * Triggers workspace-wide diagnostics for all SQL files in the dbt model and analysis
 * directories. Enabled by the dbt-studio.ninja.workspaceDiagnostics setting.
 *
 * The scanner does not run diagnostics itself — it uses content hashes to detect changed
 * files and opens them via VS Code so DiagnosticsProvider handles all validation.
 */
export class NinjaWorkspaceScanner implements vscode.Disposable {
	private readonly _statusBarItem: vscode.StatusBarItem;
	private readonly _contentHashes = new Map<string, string>();
	private readonly _disposables: vscode.Disposable[] = [];
	/** Lets a new scanAll() cancel an already-running scan. */
	private _scanAbort: AbortController | null = null;

	private _scanning = false;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly pathResolver: DbtPathResolver,
		private readonly logger: ILogger,
		_context: vscode.ExtensionContext,
	) {

		this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		this._statusBarItem.name = 'Ninja Workspace';
		this._statusBarItem.command = 'dbt-studio.ninja.statusBarMenu';
		this._statusBarItem.tooltip = 'Ninja workspace diagnostics — click for options';
		this._updateStatusBar();
		this._statusBarItem.show();

		this._disposables.push(this._statusBarItem);
	}

	/**
	 * Scans all SQL files in the dbt model and analysis directories.
	 * Skips files whose content hash has not changed since the last scan.
	 * Cancels any previously running scan.
	 */
	async scanAll(): Promise<void> {
		this._scanAbort?.abort();
		const abort = new AbortController();
		this._scanAbort = abort;

		this._scanning = true;
		this._updateStatusBar();
		const start = Date.now();

		try {
			const adapterType = this.indexer.adapterType;
			if (!adapterType) {
				this.logger.debug('[workspace-scanner] no adapterType resolved — skipping scan (manifest not loaded)');
				return;
			}

			const dirs = [
				...this.pathResolver.paths.model,
				...this.pathResolver.paths.analysis,
			];

			if (dirs.length === 0) {
				this.logger.debug('[workspace-scanner] no model/analysis directories configured');
				return;
			}

			// Find SQL files in each configured directory in parallel
			const uriSets = await Promise.all(
				dirs.map(dir => vscode.workspace.findFiles(
					new vscode.RelativePattern(vscode.Uri.file(dir), '**/*.sql'),
				)),
			);
			if (abort.signal.aborted) return;

			// Deduplicate in case directories overlap
			const seen = new Set<string>();
			const uris: vscode.Uri[] = [];
			for (const set of uriSets) {
				for (const uri of set) {
					if (!seen.has(uri.toString())) {
						seen.add(uri.toString());
						uris.push(uri);
					}
				}
			}

			const concurrency = Math.max(1, Math.min(4, os.cpus().length - 1));
			this.logger.debug(`[workspace-scanner] found ${uris.length} SQL files in model/analysis dirs (concurrency: ${concurrency})`);

			await this._scanWithConcurrency(uris, abort.signal, concurrency);

			if (!abort.signal.aborted) {
				this.logger.debug(`[workspace-scanner] scan complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
			}
		} finally {
			this._scanning = false;
			this._updateStatusBar();
		}
	}

	/**
	 * Clears the cached hash and re-opens the file to trigger diagnostics.
	 * Called on save events.
	 */
	async invalidate(uri: vscode.Uri): Promise<void> {
		this._contentHashes.delete(uri.toString());
		try {
			await this._scanFile(uri, new AbortController().signal);
		} catch (err) {
			this.logger.debug(`[workspace-scanner] error invalidating ${uri.fsPath}: ${String(err)}`);
		}
	}

	/** Clears all cached hashes. */
	clear(): void {
		this._contentHashes.clear();
	}

	dispose(): void {
		this._scanAbort?.abort();
		for (const d of this._disposables) d.dispose();
	}

	private async _scanWithConcurrency(uris: vscode.Uri[], signal: AbortSignal, concurrency: number): Promise<void> {
		const queue = uris.slice();
		const worker = async (): Promise<void> => {
			while (queue.length > 0 && !signal.aborted) {
				const uri = queue.shift()!;
				await this._scanFile(uri, signal)
					.catch(err => this.logger.debug(`[workspace-scanner] error scanning ${uri.fsPath}: ${String(err)}`));
			}
		};
		await Promise.all(Array.from({ length: concurrency }, worker));
	}

	private async _scanFile(uri: vscode.Uri, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return;

		const content = await fsPromises.readFile(uri.fsPath, 'utf8');
		if (signal.aborted) return;

		const hash = crypto.createHash('sha256').update(content).digest('hex');
		const key = uri.toString();

		if (this._contentHashes.get(key) === hash) return;
		this._contentHashes.set(key, hash);

		await vscode.workspace.openTextDocument(uri);
	}

	private _updateStatusBar(): void {
		if (this._scanning) {
			this._statusBarItem.text = '$(sync~spin) Ninja: scanning…';
		} else {
			this._statusBarItem.text = '$(shield) Ninja';
		}
		this._statusBarItem.backgroundColor = undefined;
	}
}
