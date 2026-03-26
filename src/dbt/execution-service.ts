import * as vscode from 'vscode';
import type { BridgeRunner, DbtCommandResult } from './bridge-runner';
import type { ManifestWatcher } from '../indexing/manifest-watcher';
import type { ManifestLoader } from './manifest-loader';
import type { ILogger } from '../types/logger';

export type { DbtCommandResult } from './bridge-runner';

export type DbtJobType =
	| 'parse' | 'compile' | 'run' | 'test' | 'build'
	| 'seed' | 'snapshot' | 'deps' | 'show' | 'debug'
	| 'describe' | 'scope_columns' | 'get_columns' | 'column_lineage'
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
	'parse', 'compile', 'describe', 'scope_columns', 'get_columns', 'column_lineage', 'generate_cte_tests', 'run_cte_test', 'debug',
]);

const SUPPRESS_WATCHER_TYPES = new Set<DbtJobType>([
	'describe', 'scope_columns', 'get_columns', 'column_lineage', 'show', 'run_cte_test',
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

	private readonly _onJobStarted = new vscode.EventEmitter<DbtJobInfo>();
	private readonly _onJobCompleted = new vscode.EventEmitter<{ job: DbtJobInfo; result: DbtCommandResult }>();
	private readonly _onJobFailed = new vscode.EventEmitter<{ job: DbtJobInfo; error: Error }>();
	private readonly _onQueueChanged = new vscode.EventEmitter<number>();

	readonly onJobStarted = this._onJobStarted.event;
	readonly onJobCompleted = this._onJobCompleted.event;
	readonly onJobFailed = this._onJobFailed.event;
	readonly onQueueChanged = this._onQueueChanged.event;

	constructor(
		private readonly bridge: BridgeRunner,
		private readonly loader: ManifestLoader,
		private readonly watcher: ManifestWatcher,
		private readonly logger: ILogger,
	) {}

	submit(request: DbtJobRequest): Promise<DbtCommandResult> {
		if (this._disposed) {
			return Promise.reject(new Error('Execution service is disposed'));
		}

		return new Promise<DbtCommandResult>((resolve, reject) => {
			const job: DbtJob = {
				...request,
				id: this._nextJobId++,
				cancellable: request.cancellable ?? CANCELLABLE_TYPES.has(request.type),
				resolve,
				reject,
			};

			// Dedup: replace queued job of same type at lower or equal priority
			const existingIdx = this._queue.findIndex(j => j.type === job.type && j.priority <= job.priority);
			if (existingIdx !== -1) {
				const existing = this._queue[existingIdx];
				this.logger.debug(`Dedup: replacing queued ${existing.type} (id=${existing.id}) with id=${job.id}`);
				existing.reject(new Error('Superseded by higher-priority job'));
				this._queue.splice(existingIdx, 1);
			}

			// Insert in priority order (higher priority closer to front)
			let insertIdx = this._queue.findIndex(j => j.priority < job.priority);
			if (insertIdx === -1) insertIdx = this._queue.length;
			this._queue.splice(insertIdx, 0, job);

			this.logger.info(`Job queued: [${job.id}] ${job.label} (priority=${job.priority}, origin=${job.origin})`);
			this._onQueueChanged.fire(this._queue.length);
			this._processNext();
		});
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
		if (this._activeJob || this._queue.length === 0) return;

		const job = this._queue.shift()!;
		this._activeJob = job;
		this._onQueueChanged.fire(this._queue.length);
		void this._executeJob(job);
	}

	private async _executeJob(job: DbtJob): Promise<void> {
		this.logger.info(`Job started: [${job.id}] ${job.label}`);
		this._onJobStarted.fire(this._toJobInfo(job));

		const shouldSuppressWatcher = SUPPRESS_WATCHER_TYPES.has(job.type);
		if (shouldSuppressWatcher) {
			this.watcher.suppress();
		}

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

			this._onJobCompleted.fire({ job: this._toJobInfo(job), result });
			job.resolve(result);
		} catch (err) {
			const error = err instanceof Error ? err : new Error(String(err));
			this._onJobFailed.fire({ job: this._toJobInfo(job), error });
			job.reject(error);
		} finally {
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
	}
}
