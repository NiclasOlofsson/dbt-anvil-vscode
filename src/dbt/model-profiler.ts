import * as vscode from 'vscode';
import type { ParseService } from '../services/parse-service';
import type { DatabaseProvider, CancelSignal, QueryHints } from '../providers/database/database-provider';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import type { CompileCache } from './compile-cache';
import { Priority } from './execution-service';
import type { CteProfile, ProfileResult } from './profiler-types';
import type { ProfileResultPersistence } from './profile-result-persistence';


/**
 * Profiles a dbt SQL model by executing cumulative CTE sub-queries and
 * measuring wall-clock time for each step.
 *
 * Strategy: for a model with CTEs [a, b, c], use the source document text and
 * the endLine positions from the parse service to build queries:
 *   WITH a AS (...) SELECT COUNT(*) AS _profile_count FROM a
 *   WITH a AS (...), b AS (...) SELECT COUNT(*) AS _profile_count FROM b
 *   WITH a AS (...), b AS (...), c AS (...) SELECT COUNT(*) AS _profile_count FROM c
 *   WITH a AS (...), b AS (...), c AS (...), __profiler_final__ AS (<final SELECT>)
 *     SELECT COUNT(*) AS _profile_count FROM __profiler_final__
 *
 * Raw Jinja SQL is sent as-is — the query engine handles compilation.
 * Marginal time of b = cumulativeTime(a,b) − cumulativeTime(a).
 * COUNT(*) forces full execution of the CTE chain without transferring rows.
 */
export class ModelProfiler implements vscode.Disposable {
	private readonly _results = new Map<string, ProfileResult>();
	private readonly _activeSources = new Map<string, vscode.CancellationTokenSource>();
	private readonly _onProfileStarted = new vscode.EventEmitter<string>();
	private readonly _onProfileComplete = new vscode.EventEmitter<ProfileResult>();

	/** Fired when profiling begins for a model — carries the model's uniqueId. */
	readonly onProfileStarted = this._onProfileStarted.event;

	/** Fired when profiling finishes (status: complete / partial / error) or when the running
	    placeholder is first installed (status: running). */
	readonly onProfileComplete = this._onProfileComplete.event;

	private _persistence?: ProfileResultPersistence;

	constructor(
		private readonly _parseService: ParseService,
		private readonly _dbProvider: DatabaseProvider,
		private readonly _indexer: ManifestIndexer,
		private readonly _compileCache: CompileCache,
		private readonly _logger: ILogger,
	) {}

	/**
	 * Attach a persistence layer. Call once at activation after constructing the profiler.
	 * Restores saved results immediately so the tree/decorations are populated on startup.
	 */
	initPersistence(persistence: ProfileResultPersistence): void {
		this._persistence = persistence;
		const restored = persistence.restore();
		for (const [id, result] of restored) {
			this._results.set(id, result);
			this._onProfileComplete.fire(result);
		}
	}

	dispose(): void {
		for (const cts of this._activeSources.values()) cts.cancel();
		this._activeSources.clear();
		this._onProfileStarted.dispose();
		this._onProfileComplete.dispose();
	}

	/** Cancel an in-progress profile run for a model. No-op if not running. */
	cancelProfiling(modelId: string): void {
		this._activeSources.get(modelId)?.cancel();
	}

	getResult(modelId: string): ProfileResult | undefined {
		return this._results.get(modelId);
	}

	getAllResults(): ProfileResult[] {
		return [...this._results.values()];
	}

	clearResult(modelId: string): void {
		this._results.delete(modelId);
	}

	clearAll(): void {
		this._results.clear();
	}

	getResultForFile(filePath: string): ProfileResult | undefined {
		const uid = this._indexer.findModelByFilePath(filePath);
		return uid ? this._results.get(uid) : undefined;
	}

	/**
	 * Profile the dbt model corresponding to `document`.
	 * Does NOT throw on query failures — partial results are still returned.
	 */
	async profileDocument(
		document: vscode.TextDocument,
		token?: vscode.CancellationToken,
	): Promise<ProfileResult> {
		const uniqueId = this._indexer.findModelByFilePath(document.fileName);
		if (!uniqueId) {
			throw new Error(`File '${document.fileName}' is not a manifest-indexed model.`);
		}

		const rawNode = this._indexer.getRawNode(uniqueId);
		if (!rawNode || rawNode.resource_type !== 'model') {
			throw new Error(`'${uniqueId}' is not a model node.`);
		}

		this._onProfileStarted.fire(uniqueId);

		// Cancel any existing run for this model, then create a fresh source
		this._activeSources.get(uniqueId)?.cancel();
		const cts = new vscode.CancellationTokenSource();
		this._activeSources.set(uniqueId, cts);
		const externalSub = token?.onCancellationRequested(() => cts.cancel());

		const placeholder: ProfileResult = {
			modelId: uniqueId,
			modelName: rawNode.name,
			sourceFilePath: document.fileName,
			totalTimeMs: 0,
			totalRowCount: 0,
			cteProfiles: [],
			timestamp: Date.now(),
			status: 'running',
		};
		this._results.set(uniqueId, placeholder);
		this._onProfileComplete.fire(placeholder);

		const onProgress = (partial: ProfileResult): void => {
			this._results.set(uniqueId, partial);
			this._onProfileComplete.fire(partial);
		};

		try {
			const result = await this._doProfile(document, uniqueId, rawNode, placeholder, onProgress, cts.token);
			this._results.set(uniqueId, result);
			this._onProfileComplete.fire(result);
			this._persistence?.save(this._results);
			return result;
		} catch (err) {
			const errResult: ProfileResult = {
				...placeholder,
				status: cts.token.isCancellationRequested ? 'partial' : 'error',
				error: err instanceof Error ? err.message : String(err),
			};
			this._results.set(uniqueId, errResult);
			this._onProfileComplete.fire(errResult);
			if (cts.token.isCancellationRequested) this._persistence?.save(this._results);
			if (!cts.token.isCancellationRequested) throw err;
			return errResult;
		} finally {
			externalSub?.dispose();
			cts.dispose();
			this._activeSources.delete(uniqueId);
		}
	}

	private async _doProfile(
		document: vscode.TextDocument,
		uniqueId: string,
		rawNode: { name: string; original_file_path: string },
		placeholder: ProfileResult,
		onProgress: (partial: ProfileResult) => void,
		token?: vscode.CancellationToken,
	): Promise<ProfileResult> {
		const adapterType = this._indexer.index?.adapterType ?? 'ansi';

		// 1. Compile the model once — reuses CompileCache if already compiled.
		// This gives us clean SQL with all Jinja expanded, which we parse and slice
		// instead of sending raw Jinja per-query. Eliminates N compile_inline calls.
		this._logger.info(`Profiler: compiling ${rawNode.name}...`);
		const compiledSql = await this._compileCache.ensureCompiled(
			uniqueId, rawNode.name, this._indexer.projectDir, rawNode.original_file_path,
		);
		if (!compiledSql) {
			throw new Error(`Profiler: could not compile '${rawNode.name}'`);
		}

		// 2. Parse CTE names + endLine positions from compiled SQL.
		// Compiled SQL is clean (no Jinja), giving reliable line positions for query slicing.
		// Source line positions for decorations/navigation are the parse service's concern.
		const compiledCtes = await this._parseService.parseSqlString(compiledSql, adapterType);
		const compiledEndLineByName = new Map(compiledCtes.map(c => [c.name, c.endLine]));
		const ctes = compiledCtes;

		this._logger.info(`Profiler: ${rawNode.name} has ${ctes.length} CTEs, starting queries`);

		// Update placeholder with the known total so CodeLens can show N/total.
		onProgress({ ...placeholder, totalCtes: ctes.length, pendingCteNames: ctes.map(c => c.name) });

		if (token?.isCancellationRequested) {
			throw new Error('Profiling cancelled.');
		}

		const cancelSignal = token ? _vscodeCancelToSignal(token) : undefined;
		const lines = compiledSql.split('\n');
		const runTs = String(Date.now());

		// 3. Warmup: run the full model query once to prime the warehouse's IO cache
		// (Delta Parquet files → SSD) so CTE timings reflect compute, not cold storage.
		const lastCompiledCte = compiledCtes[compiledCtes.length - 1];
		const fullQuery = lastCompiledCte
			? _buildFullModelQuery(lines, lastCompiledCte.endLine, runTs)
			: _buildNoCteFullModelQuery(compiledSql, runTs);

		this._logger.info('Profiler: running warmup query to prime Delta table cache...');
		try {
			await this._dbProvider.query(fullQuery, 1, cancelSignal, Priority.Background);
		} catch (e) {
			this._logger.warn(`Profiler: warmup query failed (continuing): ${e}`);
		}

		if (token?.isCancellationRequested) {
			throw new Error('Profiling cancelled.');
		}

		// 4. Execute cumulative profiling queries for each CTE.
		const cteProfiles: CteProfile[] = [];
		let prevCumulativeMs = 0;

		for (const cte of ctes) {
			if (token?.isCancellationRequested) break;

			const compiledEndLine = compiledEndLineByName.get(cte.name);
			if (compiledEndLine === undefined) continue;
			const profilingQuery = _buildCteQuery(lines, compiledEndLine, cte.name, runTs);

			this._logger.debug(`Profiler: executing query for CTE '${cte.name}'`);
			let rowCount = 0;
			let queryTimeMs = 0;
			try {
				const qr = await this._dbProvider.query(profilingQuery, 1, cancelSignal, Priority.Background);
				rowCount = _extractCount(qr.rows[0]);
				queryTimeMs = qr.executionTimeMs;
			} catch (e) {
				if (token?.isCancellationRequested) break;
				this._logger.warn(`Profiler: query failed for CTE '${cte.name}': ${e}`);
				continue;
			}

			cteProfiles.push({
				name: cte.name,
				queryTimeMs,
				marginalTimeMs: queryTimeMs - prevCumulativeMs,
				rowCount,
				fractionOfTotal: 0,
			});

			const completedNames = new Set(cteProfiles.map(p => p.name));
			onProgress({
				...placeholder,
				cteProfiles: [...cteProfiles],
				totalCtes: ctes.length,
				pendingCteNames: ctes.filter(c => !completedNames.has(c.name)).map(c => c.name),
			});

			prevCumulativeMs = queryTimeMs;
		}

		// 5. Time the full model (fullQuery already built for the warmup run).
		this._logger.debug('Profiler: executing full model query');
		let totalRowCount = 0;
		let totalTimeMs = 0;
		try {
			const fullResult = await this._dbProvider.query(fullQuery, 1, cancelSignal, Priority.Background);
			totalRowCount = _extractCount(fullResult.rows[0]);
			totalTimeMs = fullResult.executionTimeMs;
		} catch (e) {
			this._logger.warn(`Profiler: full model query failed: ${e}`);
		}

		// fractionOfTotal is based on absolute queryTimeMs so heat colors reflect real cost,
		// not the inaccurate marginal delta (which assumes a linear CTE dependency chain).
		for (const p of cteProfiles) {
			p.fractionOfTotal = totalTimeMs > 0 ? p.queryTimeMs / totalTimeMs : 0;
		}

		const status = token?.isCancellationRequested ? 'partial' : 'complete';

		this._logger.info(
			`Profiler: ${rawNode.name} complete — ${totalTimeMs.toFixed(0)}ms total, `
			+ `${cteProfiles.length} CTEs profiled`,
		);

		return {
			modelId: uniqueId,
			modelName: rawNode.name,
			sourceFilePath: document.fileName,
			totalTimeMs,
			totalRowCount,
			cteProfiles,
			timestamp: Date.now(),
			status,
		};
	}

}

/**
 * Build a cumulative profiling query for a single CTE.
 * Slices the source SQL at `endLine` (the closing-paren line), strips any
 * trailing comma, and appends COUNT(*) FROM <cteName>.
 * Raw Jinja is preserved — the query engine compiles it.
 */
function _buildCteQuery(lines: string[], endLine: number, cteName: string, runTs: string): string {
	const fragment = lines.slice(0, endLine + 1);
	fragment[fragment.length - 1] = fragment[fragment.length - 1].replace(/,\s*$/, '');
	return `${fragment.join('\n')}\nSELECT COUNT(*) AS _profile_count, '${runTs}' AS _profiler_start_ts FROM ${cteName}`;
}

/**
 * Build the full-model profiling query when the model has CTEs.
 * Appends __profiler_final__ CTE wrapping the final SELECT, then counts from it.
 * This is valid in all SQL dialects (no subquery-wrapping a WITH block).
 */
function _buildFullModelQuery(lines: string[], lastCteEndLine: number, runTs: string): string {
	const header = lines.slice(0, lastCteEndLine + 1);
	header[header.length - 1] = header[header.length - 1].replace(/,\s*$/, '');
	const finalSelect = lines.slice(lastCteEndLine + 1).join('\n');
	return `${header.join('\n')},\n__profiler_final__ AS (\n${finalSelect}\n)\nSELECT COUNT(*) AS _profile_count, '${runTs}' AS _profiler_start_ts FROM __profiler_final__`;
}

/**
 * Build the full-model profiling query for a model with no CTEs.
 * Wraps the entire source in a WITH block.
 */
function _buildNoCteFullModelQuery(rawSql: string, runTs: string): string {
	return `WITH __profiler_final__ AS (\n${rawSql}\n)\nSELECT COUNT(*) AS _profile_count, '${runTs}' AS _profiler_start_ts FROM __profiler_final__`;
}

function _vscodeCancelToSignal(token: vscode.CancellationToken): CancelSignal {
	const controller = new AbortController();
	token.onCancellationRequested(() => controller.abort());
	return controller.signal;
}

function _extractCount(row: Record<string, unknown> | undefined): number {
	if (!row) return 0;
	// Databases return the COUNT(*) column under various names; our alias is
	// _profile_count but guard against case-folding and dialect differences.
	const val
		= row['_profile_count']
		?? row['_PROFILE_COUNT']
		?? row['count(*)']
		?? row['COUNT(*)']
		?? row['count_star()']
		?? Object.values(row)[0];
	return Number(val ?? 0);
}


