import * as crypto from 'node:crypto';
import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import type { ParseService, DocumentModel } from '../services/parse-service';
import type { DbtPathResolver } from '../dbt/dbt-path-resolver';
import { tokenize } from '../dbt/jinja-tokenizer';
import { runNinja } from './engine';
import { loadConfig } from './config-loader';

const CONCURRENCY = 4;

/**
 * Runs Ninja linting across all SQL files in the dbt model and analysis directories
 * (not the entire workspace). Enabled by the dbt-studio.ninja.workspaceDiagnostics setting.
 *
 * Maintains a separate DiagnosticCollection so its results appear alongside
 * (but do not interfere with) the per-editor diagnostics from DiagnosticsProvider.
 */
export class NinjaWorkspaceScanner implements vscode.Disposable {
	private readonly _collection = vscode.languages.createDiagnosticCollection('dbt-studio-ninja-workspace');
	private readonly _statusBarItem: vscode.StatusBarItem;
	private readonly _contentHashes = new Map<string, string>();
	private readonly _disposables: vscode.Disposable[] = [];
	/** Lets a new scanAll() cancel an already-running scan. */
	private _scanAbort: AbortController | null = null;
	/** Debounce timer for status bar updates. */
	private _statusUpdateTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		private readonly parseService: ParseService,
		private readonly indexer: ManifestIndexer,
		private readonly pathResolver: DbtPathResolver,
		private readonly logger: ILogger,
	) {
		this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		this._statusBarItem.name = 'Ninja Workspace';
		this._statusBarItem.command = 'workbench.action.problems.focus';
		this._statusBarItem.tooltip = 'Ninja workspace diagnostics — click to open Problems panel';
		this._updateStatusBar();
		this._statusBarItem.show();

		this._disposables.push(this._collection, this._statusBarItem);
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

		this.logger.debug('[workspace-scanner] starting full scan');

		const config = loadConfig();
		if (!config.enabled) {
			this.clear();
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

		this.logger.debug(`[workspace-scanner] found ${uris.length} SQL files in model/analysis dirs`);

		const dialect = this.indexer.dialect;
		let active = 0;
		let index = 0;

		await new Promise<void>((resolve) => {
			const next = () => {
				if (abort.signal.aborted) { resolve(); return; }
				if (index >= uris.length && active === 0) { resolve(); return; }

				while (active < CONCURRENCY && index < uris.length) {
					const uri = uris[index++];
					active++;
					this._scanFile(uri, dialect, config, abort.signal)
						.catch(err => this.logger.debug(`[workspace-scanner] error scanning ${uri.fsPath}: ${String(err)}`))
						.finally(() => {
							active--;
							next();
						});
				}
			};
			next();
		});

		if (!abort.signal.aborted) {
			this._updateStatusBar();
			this.logger.debug('[workspace-scanner] scan complete');
		}
	}

	/**
	 * Clears the cached hash and re-scans a single file.
	 * Called on save events.
	 */
	async invalidate(uri: vscode.Uri): Promise<void> {
		const config = loadConfig();
		if (!config.enabled) return;

		this._contentHashes.delete(uri.toString());
		const dialect = this.indexer.dialect;

		try {
			await this._scanFile(uri, dialect, config, new AbortController().signal);
		} catch (err) {
			this.logger.debug(`[workspace-scanner] error invalidating ${uri.fsPath}: ${String(err)}`);
		}

		this._updateStatusBar();
	}

	/** Clears all diagnostics and cached hashes. */
	clear(): void {
		this._collection.clear();
		this._contentHashes.clear();
		this._updateStatusBar();
	}

	dispose(): void {
		this._scanAbort?.abort();
		if (this._statusUpdateTimer) clearTimeout(this._statusUpdateTimer);
		for (const d of this._disposables) d.dispose();
	}

	private async _scanFile(
		uri: vscode.Uri,
		dialect: string | undefined,
		config: ReturnType<typeof loadConfig>,
		signal: AbortSignal,
	): Promise<void> {
		if (signal.aborted) return;

		const document = await vscode.workspace.openTextDocument(uri);
		if (signal.aborted) return;

		const content = document.getText();
		const hash = crypto.createHash('sha256').update(content).digest('hex');
		const key = uri.toString();

		if (this._contentHashes.get(key) === hash) return;
		this._contentHashes.set(key, hash);

		const model = await this.parseService.getDocumentModel(document, dialect, { skipEnrichment: true });
		if (signal.aborted) return;

		const emptyModel: DocumentModel = { ctes: [], refs: [], sources: [], tokens: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		const jinjaTokens = tokenize(content);
		const result = runNinja(document, model ?? emptyModel, jinjaTokens, config);

		const diagnostics = result.violations.map(v => {
			const diag = new vscode.Diagnostic(v.range, v.message, result.severityMap.get(v.rule));
			diag.source = 'ninja';
			diag.code = v.rule;
			return diag;
		});

		this._collection.set(uri, diagnostics);
	}

	private _scheduleStatusBar(): void {
		if (this._statusUpdateTimer) clearTimeout(this._statusUpdateTimer);
		this._statusUpdateTimer = setTimeout(() => {
			this._statusUpdateTimer = null;
			this._updateStatusBar();
		}, 500);
	}

	private _updateStatusBar(): void {
		let total = 0;
		this._collection.forEach((_, diags) => { total += diags.length; });
		this._statusBarItem.text = total > 0 ? `$(shield) Ninja: ${total} issues` : `$(shield) Ninja`;
		this._statusBarItem.color = total > 0 ? new vscode.ThemeColor('statusBarItem.warningForeground') : undefined;
	}
}
