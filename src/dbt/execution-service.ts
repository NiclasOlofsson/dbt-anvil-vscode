import * as vscode from 'vscode';
import type { BridgeRunner, DbtCommandResult, DbtLogEvent } from './bridge-runner';
import type { IManifestSuppressor } from '../indexing/manifest-watcher';
import type { ManifestLoader } from './manifest-loader';
import type { ILogger } from '../types/logger';

export type { DbtCommandResult } from './bridge-runner';

export type DbtExecutionEvent =
	| { type: 'start';    job: DbtJobInfo }
	| { type: 'progress'; job: DbtJobInfo; event: DbtLogEvent }
	| { type: 'end';      job: DbtJobInfo; success: boolean };

export type DbtJobType =
	| 'parse' | 'compile' | 'compile_inline' | 'run' | 'test' | 'build'
	| 'seed' | 'snapshot' | 'deps' | 'show' | 'debug'
	| 'describe'
	| 'generate_cte_tests' | 'run_cte_test';

export type DbtJobOrigin = 'user' | 'copilot' | 'provider' | 'background';

export type DbtJobPriority = 0 | 1 | 2 | 3;

export const Priority = {
	Background: 0 as DbtJobPriority,
	Provider: 1 as DbtJobPriority,
	Tool: 2 as DbtJobPriority,
	User: 3 as DbtJobPriority,
} as const;

export interface DbtJobRequest {
	type: DbtJobType;
	args?: string[];
	raw?: Record<string, unknown>;
	priority: DbtJobPriority;
	origin: DbtJobOrigin;
	label: string;
	cancellable?: boolean;
}

export interface DbtJobInfo {
	id: number;
	type: DbtJobType;
	priority: DbtJobPriority;
	origin: DbtJobOrigin;
	label: string;
	cancellable: boolean;
}

interface DbtJob extends DbtJobInfo {
	args?: string[];
	raw?: Record<string, unknown>;
	resolve: (result: DbtCommandResult) => void;
	reject: (error: Error) => void;
}

const CANCELLABLE_TYPES = new Set<DbtJobType>([
	'parse', 'compile', 'compile_inline', 'describe', 'generate_cte_tests', 'run_cte_test', 'debug',
]);

/**
 * Job types where an *active* job can be cancelled by hard-killing and
 * respawning the bridge. Reserved for long-running user-visible commands
 * where a kill is worth the bridge restart cost.
 */
const HARD_CANCEL_TYPES = new Set<DbtJobType>([
	'run', 'build', 'test', 'seed', 'snapshot', 'deps',
]);

/**
 * Types where at most one job per unique key may sit in the queue at a time.
 * When a conflict is found, the higher-priority job survives; on a tie the
 * incoming job replaces the existing one (latest wins for idempotent ops).
 * `parse` has no meaningful args so it deduplicates globally.
 * `compile` deduplicates per selector so two different models can still queue.
 */
const STRICT_DEDUP_TYPES = new Set<DbtJobType>(['parse', 'compile']);

const SUPPRESS_WATCHER_TYPES = new Set<DbtJobType>([
	'describe', 'show', 'run_cte_test',
]);

const SAVE_STATE_TYPES = new Set<DbtJobType>(['run', 'build', 'seed']);

const INVALIDATE_LOADER_TYPES = new Set<DbtJobType>([
	'run', 'build', 'compile', 'seed', 'snapshot', 'deps', 'parse',
]);

export class DbtExecutionService implements vscode.Disposable {
	private _queue: DbtJob[] = [];
	private _activeJob: DbtJob | null = null;
	private _nextJobId = 1;
	private _disposed = false;
	private _suspended = false;

	private readonly _onJobStarted = new vscode.EventEmitter<DbtJobInfo>();
	private readonly _onJobCompleted = new vscode.EventEmitter<{ job: DbtJobInfo; result: DbtCommandResult }>();
	private readonly _onJobFailed = new vscode.EventEmitter<{ job: DbtJobInfo; error: Error }>();
	private readonly _onQueueChanged = new vscode.EventEmitter<number>();
	private readonly _onExecutionEvent = new vscode.EventEmitter<DbtExecutionEvent>();

	readonly onJobStarted = this._onJobStarted.event;
	readonly onJobCompleted = this._onJobCompleted.event;
	readonly onJobFailed = this._onJobFailed.event;
	readonly onQueueChanged = this._onQueueChanged.event;
	readonly onExecutionEvent = this._onExecutionEvent.event;

	constructor(
		private readonly bridge: BridgeRunner,
		private readonly loader: ManifestLoader,
		private readonly watcher: IManifestSuppressor,
		private readonly logger: ILogger,
	) {}

	/** Dedup key: type alone for arg-less commands, type+args for parameterised ones. */
	private _jobKey(job: DbtJob): string {
		return job.args ? job.type + ':' + job.args.join('\0') : job.type;
	}

	submit(request: DbtJobRequest, token?: vscode.CancellationToken): Promise<DbtCommandResult> {
		if (this._disposed) {
			return Promise.reject(new Error('Execution service is disposed'));
		}

		if (token?.isCancellationRequested) {
			return Promise.reject(new Error('Job cancelled before submission'));
		}

		return new Promise<DbtCommandResult>((resolve, reject) => {
			const job: DbtJob = {
				...request,
				id: this._nextJobId++,
				cancellable: request.cancellable ?? CANCELLABLE_TYPES.has(request.type),
				resolve,
				reject,
			};

			if (STRICT_DEDUP_TYPES.has(job.type)) {
				// Strict dedup: at most one job per key in the queue regardless of priority direction.
				const key = this._jobKey(job);
				const existingIdx = this._queue.findIndex(j => this._jobKey(j) === key);
				if (existingIdx !== -1) {
					const existing = this._queue[existingIdx];
					if (existing.priority > job.priority) {
						// Existing has higher priority — drop the incoming job
						this.logger.debug(`Dedup: dropping ${job.type} (id=${job.id}) — higher-priority job already queued (id=${existing.id})`);
						reject(new Error('Superseded by higher-priority queued job'));
						return;
					}
					// Incoming same or higher priority — replace existing
					this.logger.debug(`Dedup: replacing queued ${existing.type} (id=${existing.id}) with id=${job.id}`);
					existing.reject(new Error('Superseded by higher-priority job'));
					this._queue.splice(existingIdx, 1);
				}
			} else {
				// Standard dedup: replace a queued same-type job only when it has lower or equal priority
				const existingIdx = this._queue.findIndex(j => j.type === job.type && j.priority <= job.priority);
				if (existingIdx !== -1) {
					const existing = this._queue[existingIdx];
					this.logger.debug(`Dedup: replacing queued ${existing.type} (id=${existing.id}) with id=${job.id}`);
					existing.reject(new Error('Superseded by higher-priority job'));
					this._queue.splice(existingIdx, 1);
				}
			}

			// Insert in priority order (higher priority closer to front)
			let insertIdx = this._queue.findIndex(j => j.priority < job.priority);
			if (insertIdx === -1) insertIdx = this._queue.length;
			this._queue.splice(insertIdx, 0, job);

			if (token) {
				const tokenSub = token.onCancellationRequested(() => {
					if (this.cancel(job.id)) return;
					this.cancelActive(job.id);
				});
				const origResolve = job.resolve;
				const origReject = job.reject;
				job.resolve = (r) => { tokenSub.dispose(); origResolve(r); };
				job.reject = (e) => { tokenSub.dispose(); origReject(e); };
			}

			this.logger.info(`Job queued: [${job.id}] ${job.label} (priority=${job.priority}, origin=${job.origin})`);
			this._onQueueChanged.fire(this._queue.length);
			this._processNext();
		});
	}

	/**
	 * Cancel an active job by hard-killing the bridge process. Only effective
	 * for job types in {@link HARD_CANCEL_TYPES}; for fast in-process work the
	 * restart cost outweighs the benefit and the call is a no-op.
	 *
	 * Returns true when the kill was issued. The job's promise will resolve
	 * via the bridge's pending-request fail path (not reject).
	 */
	cancelActive(jobId: number): boolean {
		if (!this._activeJob || this._activeJob.id !== jobId) return false;
		if (!HARD_CANCEL_TYPES.has(this._activeJob.type)) {
			this.logger.info(`Active job [${jobId}] ${this._activeJob.type} is not hard-cancellable; ignoring cancel`);
			return false;
		}
		this.logger.info(`Hard-cancelling active job [${jobId}] ${this._activeJob.label}`);
		return this.bridge.killActive(`Job cancelled: ${this._activeJob.label}`);
	}

	cancel(jobId: number): boolean {
		const qIdx = this._queue.findIndex(j => j.id === jobId);
		if (qIdx !== -1) {
			const job = this._queue[qIdx];
			this._queue.splice(qIdx, 1);
			job.reject(new Error('Job cancelled'));
			this.logger.info(`Job cancelled: [${jobId}] ${job.label}`);
			this._onQueueChanged.fire(this._queue.length);
			return true;
		}
		return false;
	}

	get activeJobPriority(): DbtJobPriority | null {
		return this._activeJob?.priority ?? null;
	}

	/**
	 * Suspend the execution service while an external dbt command is running in a terminal.
	 * Cancels all queued cancellable jobs (background ops) so they don't pile up.
	 * Non-cancellable (user-initiated) jobs remain queued and run after resume().
	 */
	suspend(): void {
		this._suspended = true;
		const keepJobs: DbtJob[] = [];
		for (const job of this._queue) {
			if (job.cancellable) {
				job.reject(new Error('Job cancelled: external dbt command running in terminal'));
			} else {
				keepJobs.push(job);
			}
		}
		if (keepJobs.length !== this._queue.length) {
			this._queue = keepJobs;
			this._onQueueChanged.fire(this._queue.length);
		}
		this.logger.info('DbtExecutionService: suspended (external dbt command running)');
	}

	/**
	 * Resume the execution service after the external dbt command has finished.
	 */
	resume(): void {
		if (!this._suspended) return;
		this._suspended = false;
		this.logger.info('DbtExecutionService: resumed');
		this._processNext();
	}

	getActiveJob(): DbtJobInfo | null {
		return this._activeJob ? this._toJobInfo(this._activeJob) : null;
	}

	getQueuedJobs(): DbtJobInfo[] {
		return this._queue.map(j => this._toJobInfo(j));
	}

	private _toJobInfo(job: DbtJob): DbtJobInfo {
		return {
			id: job.id,
			type: job.type,
			priority: job.priority,
			origin: job.origin,
			label: job.label,
			cancellable: job.cancellable,
		};
	}

	private _processNext(): void {
		if (this._activeJob || this._queue.length === 0 || this._suspended) return;

		const job = this._queue.shift()!;
		this._activeJob = job;
		this._onQueueChanged.fire(this._queue.length);
		void this._executeJob(job);
	}

	private async _executeJob(job: DbtJob): Promise<void> {
		this.logger.info(`Job started: [${job.id}] ${job.label}`);
		const jobInfo = this._toJobInfo(job);
		this._onJobStarted.fire(jobInfo);
		this._onExecutionEvent.fire({ type: 'start', job: jobInfo });

		const shouldSuppressWatcher = SUPPRESS_WATCHER_TYPES.has(job.type);
		if (shouldSuppressWatcher) {
			this.watcher.suppress();
		}

		const progressSub = this.bridge.onCommandEvent(event => {
			this._onExecutionEvent.fire({ type: 'progress', job: jobInfo, event });
		});

		try {
			let result: DbtCommandResult;

			if (job.raw) {
				result = await this.bridge.invokeRaw(job.raw);
			} else if (job.args) {
				result = await this.bridge.invoke(job.args);
			} else {
				throw new Error(`Job [${job.id}] has neither args nor raw request`);
			}

			if (INVALIDATE_LOADER_TYPES.has(job.type)) {
				this.loader.invalidate();
			}

			if (result.success && SAVE_STATE_TYPES.has(job.type)) {
				await this.bridge.saveRunState();
			}

			this._onExecutionEvent.fire({ type: 'end', job: jobInfo, success: result.success });
			this._onJobCompleted.fire({ job: jobInfo, result });
			job.resolve(result);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this._onExecutionEvent.fire({ type: 'end', job: jobInfo, success: false });
			this._onJobFailed.fire({ job: jobInfo, error });
			job.reject(error);
		} finally {
			progressSub.dispose();
			if (shouldSuppressWatcher) {
				this.watcher.resume();
			}
			this._activeJob = null;
			this._processNext();
		}
	}

	dispose(): void {
		this._disposed = true;
		for (const job of this._queue) {
			job.reject(new Error('Execution service disposed'));
		}
		this._queue = [];
		this._onJobStarted.dispose();
		this._onJobCompleted.dispose();
		this._onJobFailed.dispose();
		this._onQueueChanged.dispose();
		this._onExecutionEvent.dispose();
	}

	/**
	 * Compile a Jinja SQL string via `dbt compile --inline` without executing it.
	 * Returns the compiled SQL string, or rejects if compilation fails.
	 */
	async compileInline(sql: string, priority: DbtJobPriority = Priority.Tool): Promise<string> {
		const result = await this.submit({
			type: 'compile_inline',
			raw: { compile_inline: sql },
			priority,
			origin: 'provider',
			label: 'compile inline SQL',
		});
		if (!result.success || !result.data) {
			throw new Error(`compile_inline failed: ${result.stderr || 'unknown error'}`);
		}
		const compiled = result.data['compiled_sql'];
		if (typeof compiled !== 'string') {
			throw new Error('compile_inline: missing compiled_sql in bridge response');
		}
		return compiled;
	}
}
