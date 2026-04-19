import * as crypto from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import type { DbtPathResolver } from '../dbt/dbt-path-resolver';
import type { DocumentModel, ParseService } from '../services/parse-service';
import { runNinja } from './engine';
import { loadConfig } from './config-loader';
import { tokenize } from '../dbt/jinja-tokenizer';
import { TextDocumentShim } from './text-document-shim';

/** Summary emitted after a full workspace scan completes. */
export interface ScanSummary {
	fileCount: number;
	/** Violation counts under the user's current severity config. */
	ruleCounts: Map<string, number>;
	durationMs: number;
}

export interface PersistedNinjaDiagnostic {
	message: string;
	severity: number;
	startLine: number;
	startCharacter: number;
	endLine: number;
	endCharacter: number;
	source?: string;
	code?: string;
}

export interface PersistedWorkspaceScannerEntry {
	contentHash: string;
	mtimeMs: number;
	size: number;
	diagnostics: PersistedNinjaDiagnostic[];
}

export interface PersistedWorkspaceScannerSnapshot {
	version: 1;
	configHash: string;
	entries: Record<string, PersistedWorkspaceScannerEntry>;
}

/**
 * Runs workspace-wide Ninja diagnostics for all SQL files in the dbt model and
 * analysis directories. Owns its own DiagnosticCollections — independent of
 * EditorDiagnosticsProvider. Reads files directly (no openTextDocument) for speed.
 */
export class WorkspaceDiagnosticsScanner implements vscode.Disposable {
	private readonly _ninjaCollection: vscode.DiagnosticCollection;
	private readonly _contractsCollection: vscode.DiagnosticCollection;
	private readonly _statusBarItem: vscode.StatusBarItem;
	private readonly _contentHashes = new Map<string, string>();
	private readonly _fileStats = new Map<string, { mtimeMs: number; size: number }>();
	private readonly _parsedModelCache = new Map<string, DocumentModel>();
	private readonly _knownDiagnosticUris = new Set<string>();
	private readonly _diagnosticsByUri = new Map<string, vscode.Diagnostic[]>();
	private readonly _disposables: vscode.Disposable[] = [];
	/** Lets a new scanAll() cancel an already-running scan. */
	private _scanAbort: AbortController | null = null;
	private _scanning = false;
	private _countsUpdateTimer: ReturnType<typeof setTimeout> | undefined;
	private _lastConfigHash: string | undefined;

	private readonly _onDidComplete = new vscode.EventEmitter<ScanSummary>();
	readonly onDidComplete = this._onDidComplete.event;
	private readonly _onDidCountsChange = new vscode.EventEmitter<Map<string, number>>();
	readonly onDidCountsChange = this._onDidCountsChange.event;
	private readonly _onDidScanningChange = new vscode.EventEmitter<boolean>();
	readonly onDidScanningChange = this._onDidScanningChange.event;

	constructor(
		private readonly parseService: ParseService,
		private readonly indexer: ManifestIndexer,
		private readonly pathResolver: DbtPathResolver,
		private readonly logger: ILogger,
	) {
		this._ninjaCollection = vscode.languages.createDiagnosticCollection('dbt-studio-workspace-ninja');
		this._contractsCollection = vscode.languages.createDiagnosticCollection('dbt-studio-workspace-contracts');

		this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
		this._statusBarItem.name = 'Ninja Workspace';
		this._statusBarItem.command = 'dbt-studio.ninja.statusBarMenu';
		this._statusBarItem.tooltip = 'Ninja workspace diagnostics — click for options';
		this._updateStatusBar();
		this._statusBarItem.show();

		this._disposables.push(
			this._ninjaCollection,
			this._contractsCollection,
			this._statusBarItem,
			this._onDidComplete,
			this._onDidCountsChange,
			this._onDidScanningChange,
		);
	}

	/**
	 * Scans all SQL files in the dbt model and analysis directories.
	 * Files listed in `pivots` are scanned first.
	 * Skips files whose content hash has not changed since the last scan.
	 * Cancels any previously running scan.
	 */
	async scanAll(_pivots?: vscode.Uri[]): Promise<void> {
		this._scanAbort?.abort();
		const abort = new AbortController();
		this._scanAbort = abort;

		this._scanning = true;
		this._onDidScanningChange.fire(true);
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

			// Fetch scan-level shared state once (config, dialect symbols)
			const config = loadConfig();
			this._lastConfigHash = this._hashConfig(config);
			const dialectSymbols = await this.parseService.getDialectSymbols().catch(() => undefined);
			if (abort.signal.aborted) return;

			const concurrency = 4;
			this.logger.debug(`[workspace-scanner] found ${uris.length} SQL files in model/analysis dirs (concurrency: ${concurrency})`);

			await this._scanWithConcurrency(uris, abort.signal, config, dialectSymbols);

			if (!abort.signal.aborted) {
				this._runCrossModelChecks();
				this._emitCountsChange();
				const durationMs = Date.now() - start;
				this.logger.debug(`[workspace-scanner] scan complete in ${(durationMs / 1000).toFixed(1)}s`);
				this._onDidComplete.fire({
					fileCount: uris.length,
					ruleCounts: this._aggregateRuleCounts(),
					durationMs,
				});
			}
		} finally {
			this._scanning = false;
			this._onDidScanningChange.fire(false);
			this._updateStatusBar();
		}
	}

	/**
	 * Invalidates the cached hash for a URI and rescans it immediately.
	 * Called on save events for open documents.
	 */
	async invalidate(uri: vscode.Uri): Promise<void> {
		const key = uri.toString();
		this._contentHashes.delete(key);
		this._fileStats.delete(key);
		this._parsedModelCache.delete(key);
		this._knownDiagnosticUris.delete(key);
		this._diagnosticsByUri.delete(key);
		await this.scanAll([uri]);
	}

	/**
	 * Invalidates all scan-time caches so the next full scan reprocesses every file.
	 * Use this when configuration changes may affect diagnostics without changing file content.
	 */
	invalidateAllCaches(): void {
		this._contentHashes.clear();
		this._fileStats.clear();
		this._parsedModelCache.clear();
		this._knownDiagnosticUris.clear();
		this._diagnosticsByUri.clear();
	}

	/** Clears all cached hashes, model cache, and diagnostic entries. */
	clear(): void {
		this._contentHashes.clear();
		this._fileStats.clear();
		this._parsedModelCache.clear();
		this._knownDiagnosticUris.clear();
		this._diagnosticsByUri.clear();
		this._ninjaCollection.clear();
		this._contractsCollection.clear();
		this._emitCountsChange();
	}

	restoreSnapshot(snapshot: PersistedWorkspaceScannerSnapshot): boolean {
		const currentConfigHash = this._hashConfig(loadConfig());
		if (snapshot.configHash !== currentConfigHash) {
			return false;
		}

		this.clear();
		this._lastConfigHash = snapshot.configHash;

		for (const [uriStr, entry] of Object.entries(snapshot.entries)) {
			const uri = vscode.Uri.parse(uriStr);
			this._contentHashes.set(uriStr, entry.contentHash);
			this._fileStats.set(uriStr, { mtimeMs: entry.mtimeMs, size: entry.size });
			const diagnostics = entry.diagnostics.map((d) => {
				const diag = new vscode.Diagnostic(
					new vscode.Range(d.startLine, d.startCharacter, d.endLine, d.endCharacter),
					d.message,
					d.severity as vscode.DiagnosticSeverity,
				);
				diag.source = d.source ?? 'ninja';
				if (d.code) diag.code = d.code;
				return diag;
			});
			this._setNinjaDiagnostics(uri, diagnostics);
		}

		this._emitCountsChange();
		return true;
	}

	getSnapshot(): PersistedWorkspaceScannerSnapshot {
		const entries: Record<string, PersistedWorkspaceScannerEntry> = {};
		for (const [uriStr, diagnostics] of this._diagnosticsByUri.entries()) {
			const contentHash = this._contentHashes.get(uriStr);
			const stats = this._fileStats.get(uriStr);
			if (!contentHash || !stats) continue;
			entries[uriStr] = {
				contentHash,
				mtimeMs: stats.mtimeMs,
				size: stats.size,
				diagnostics: diagnostics.map((d) => ({
					message: d.message,
					severity: d.severity,
					startLine: d.range.start.line,
					startCharacter: d.range.start.character,
					endLine: d.range.end.line,
					endCharacter: d.range.end.character,
					source: d.source,
					code: typeof d.code === 'string' ? d.code : undefined,
				})),
			};
		}

		const configHash = this._lastConfigHash ?? this._hashConfig(loadConfig());
		return { version: 1, configHash, entries };
	}

	dispose(): void {
		this._scanAbort?.abort();
		if (this._countsUpdateTimer) clearTimeout(this._countsUpdateTimer);
		for (const d of this._disposables) d.dispose();
	}

	private async _scanWithConcurrency(
		uris: vscode.Uri[],
		signal: AbortSignal,
		config: ReturnType<typeof loadConfig>,
		dialectSymbols: import('../ftl/sql-parser').DialectSymbols | undefined,
	): Promise<void> {
		const queue = uris.slice();
		const openDocs = new Set(vscode.workspace.textDocuments.map(d => d.uri.toString()));
		const worker = async (): Promise<void> => {
			while (queue.length > 0 && !signal.aborted) {
				const uri = queue.shift()!;
				await this._scanFile(uri, signal, config, dialectSymbols, openDocs)
					.catch((err: unknown) => this.logger.debug(`[workspace-scanner] error scanning ${uri.fsPath}: ${String(err)}`));
			}
		};
		await Promise.all(Array.from({ length: 4 }, worker));
	}

	private async _scanFile(
		uri: vscode.Uri,
		signal: AbortSignal,
		config: ReturnType<typeof loadConfig>,
		dialectSymbols: import('../ftl/sql-parser').DialectSymbols | undefined,
		openDocs: Set<string>,
	): Promise<void> {
		if (signal.aborted) return;

		// If the file is currently open in an editor, EditorDiagnosticsProvider owns its Ninja
		// diagnostics. Clear any stale workspace-scanner entry and skip to avoid duplicates.
		const key = uri.toString();
		if (openDocs.has(key)) {
			this._ninjaCollection.delete(uri);
			this._knownDiagnosticUris.delete(key);
			this._diagnosticsByUri.delete(key);
			return;
		}

		const stat = await fsPromises.stat(uri.fsPath).catch(() => undefined);
		const prevStat = this._fileStats.get(key);
		if (
			stat
			&& prevStat
			&& prevStat.mtimeMs === stat.mtimeMs
			&& prevStat.size === stat.size
			&& this._contentHashes.has(key)
			&& this._knownDiagnosticUris.has(key)
		) {
			return;
		}

		const content = await fsPromises.readFile(uri.fsPath, 'utf8');
		// Normalize CRLF → LF so byte offsets from the Python bridge (which normalises
		// internally) align with the offsets computed by lineOffset() in token-utils.ts.
		// VS Code's document.getText() always returns LF, so every code path that works
		// through the editor already sees LF; we need to match that here.
		const normalizedContent = content.includes('\r') ? content.replace(/\r\n/g, '\n') : content;
		if (signal.aborted) return;

		const hash = crypto.createHash('sha256').update(normalizedContent).digest('hex');
		if (this._contentHashes.get(key) === hash && this._knownDiagnosticUris.has(key)) return;

		const model = await this.parseService.parseContent(uri, normalizedContent).catch(() => undefined);
		if (signal.aborted) return;

		// Only commit the hash after the cache entry is written — if we abort between
		// readFile and parseContent the hash stays uncommitted and the file is retried.
		const parsedModel: DocumentModel = model ?? { ctes: [], refs: [], sources: [], tokens: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		this._parsedModelCache.set(key, parsedModel);
		this._contentHashes.set(key, hash);
		if (stat) this._fileStats.set(key, { mtimeMs: stat.mtimeMs, size: stat.size });

		const shim = new TextDocumentShim(uri, normalizedContent);
		const jinjaTokens = tokenize(normalizedContent);
		const ninjaStart = Date.now();
		const result = runNinja(shim, parsedModel, jinjaTokens, config, dialectSymbols ?? undefined);
		const ninjaMs = Date.now() - ninjaStart;
		const fileName = uri.fsPath.replace(/\\/g, '/').split('/').pop() ?? uri.fsPath;
		this.logger.trace(`[workspace-scanner] ${fileName}  parse=${parsedModel.timing.parseMs}ms  ninja=${ninjaMs}ms`);

		const diagnostics: vscode.Diagnostic[] = result.violations.map(v => {
			const sev = result.severityMap.get(v.rule) ?? vscode.DiagnosticSeverity.Warning;
			const diag = new vscode.Diagnostic(v.range, v.message, sev);
			diag.source = 'ninja';
			diag.code = v.rule;
			return diag;
		});
		this._setNinjaDiagnostics(uri, diagnostics);
		this._scheduleCountsChange();
	}

	/** Clears the scanner's collection entry for a URI (call when editor opens the file). */
	suppressUri(uri: vscode.Uri): void {
		this._ninjaCollection.delete(uri);
	}

	private _setNinjaDiagnostics(uri: vscode.Uri, diagnostics: vscode.Diagnostic[]): void {
		const key = uri.toString();
		const isOpen = vscode.workspace.textDocuments.some(d => d.uri.toString() === key);
		if (isOpen) {
			this._ninjaCollection.delete(uri);
		} else {
			this._ninjaCollection.set(uri, diagnostics);
		}
		this._knownDiagnosticUris.add(key);
		this._diagnosticsByUri.set(key, diagnostics);
	}

	private _hashConfig(config: ReturnType<typeof loadConfig>): string {
		const stable = (value: unknown): unknown => {
			if (Array.isArray(value)) return value.map(stable);
			if (value !== null && typeof value === 'object') {
				const obj = value as Record<string, unknown>;
				const out: Record<string, unknown> = {};
				for (const k of Object.keys(obj).sort()) out[k] = stable(obj[k]);
				return out;
			}
			return value;
		};
		const json = JSON.stringify(stable(config));
		return crypto.createHash('sha256').update(json).digest('hex');
	}

	private _runCrossModelChecks(): void {
		const index = this.indexer.index;
		if (!index) return;

		const diagsByUri = new Map<string, vscode.Diagnostic[]>();
		const addDiag = (uri: vscode.Uri, diag: vscode.Diagnostic): void => {
			const key = uri.toString();
			if (!diagsByUri.has(key)) diagsByUri.set(key, []);
			diagsByUri.get(key)!.push(diag);
		};

		// 4A: flag models with no downstream model/snapshot/exposure dependents
		for (const [uid, indexedModel] of index.models) {
			if (!uid.startsWith('model.')) continue;
			const children = index.childMap.get(uid) ?? [];
			const hasDownstream = children.some(c =>
				c.startsWith('model.') || c.startsWith('snapshot.') || c.startsWith('exposure.'),
			);
			if (hasDownstream) continue;
			const diag = new vscode.Diagnostic(
				new vscode.Range(0, 0, 0, 0),
				`Model '${indexedModel.name}' is not referenced by any downstream model or exposure`,
				vscode.DiagnosticSeverity.Hint,
			);
			diag.source = 'dbt-studio';
			diag.code = 'unused-model';
			addDiag(vscode.Uri.file(indexedModel.path), diag);
		}

		// 4B: flag column references that do not exist in the upstream model's finalColumns
		for (const [uid, indexedModel] of index.models) {
			if (!uid.startsWith('model.')) continue;
			const uri = vscode.Uri.file(indexedModel.path);
			const entry = this._parsedModelCache.get(uri.toString());
			if (!entry || entry.status === 'syntax_error') continue;

			for (const ref of entry.refs) {
				if (!ref.alias) continue;

				// Resolve the upstream model uid (prefer same package, take first model.* match)
				const upstreamUids = index.nodesByName.get(ref.model) ?? [];
				const upstreamUid = upstreamUids.find(u => u.startsWith('model.'));
				if (!upstreamUid) continue;

				const upstreamIndexed = index.models.get(upstreamUid);
				if (!upstreamIndexed) continue;
				const upstreamEntry = this._parsedModelCache.get(vscode.Uri.file(upstreamIndexed.path).toString());
				if (!upstreamEntry || upstreamEntry.status === 'syntax_error') continue;

				const finalCols = upstreamEntry.finalColumns;
				if (finalCols.length === 0 || finalCols.some(c => c.name === '*')) continue;

				const knownCols = new Set(finalCols.map(c => c.name.toLowerCase()));
				const aliasLc = ref.alias.toLowerCase();

				for (const token of entry.tokens) {
					if (token.type !== 'column_ref') continue;
					if (token.table?.toLowerCase() !== aliasLc) continue;
					if (knownCols.has(token.name.toLowerCase())) continue;
					const colListSample = [...knownCols].slice(0, 5).join(', ');
					const suffix = knownCols.size > 5 ? ', …' : '';
					const diag = new vscode.Diagnostic(
						new vscode.Range(token.line, token.col, token.line, token.endCol),
						`Column '${token.name}' not found in '${ref.model}' (known: ${colListSample}${suffix})`,
						vscode.DiagnosticSeverity.Error,
					);
					diag.source = 'dbt-studio';
					diag.code = 'column-contract-break';
					addDiag(uri, diag);
				}
			}
		}

		this._contractsCollection.clear();
		for (const [uriStr, diags] of diagsByUri) {
			this._contractsCollection.set(vscode.Uri.parse(uriStr), diags);
		}
	}

	/** Current per-rule violation counts from the already-scanned diagnostic collection. */
	get currentRuleCounts(): Map<string, number> {
		return this._aggregateRuleCounts();
	}

	get isScanning(): boolean {
		return this._scanning;
	}

	/** Aggregate per-rule violation counts from the current ninja diagnostic collection. */
	private _aggregateRuleCounts(): Map<string, number> {
		const counts = new Map<string, number>();
		this._ninjaCollection.forEach((_uri, diags) => {
			for (const d of diags) {
				if (typeof d.code === 'string') {
					counts.set(d.code, (counts.get(d.code) ?? 0) + 1);
				}
			}
		});
		return counts;
	}

	private _scheduleCountsChange(): void {
		if (this._countsUpdateTimer) return;
		this._countsUpdateTimer = setTimeout(() => {
			this._countsUpdateTimer = undefined;
			this._emitCountsChange();
		}, 250);
	}

	private _emitCountsChange(): void {
		if (this._countsUpdateTimer) {
			clearTimeout(this._countsUpdateTimer);
			this._countsUpdateTimer = undefined;
		}
		this._onDidCountsChange.fire(this._aggregateRuleCounts());
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
