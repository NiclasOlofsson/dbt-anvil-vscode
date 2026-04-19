import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ParseResult } from './parse-result';
import type { DialectSymbols, SqlParser } from './sql-parser';

interface PendingParseTask {
	id: number;
	kind: 'parse';
	sql: string;
	dialect: string;
	schemaJson: string;
	resolve: (result: ParseResult) => void;
	reject: (err: Error) => void;
}

interface PendingLineageTask {
	id: number;
	kind: 'lineage';
	compiledSql: string;
	columnName: string;
	dialect: string;
	schemaJson: string;
	resolve: (result: string) => void;
	reject: (err: Error) => void;
}

interface PendingLineageV2Task {
	id: number;
	kind: 'lineage_v2';
	sql: string;
	columnName: string;
	dialect: string;
	schemaJson: string;
	resolve: (result: string) => void;
	reject: (err: Error) => void;
}

interface PendingDecomposeTask {
	id: number;
	kind: 'decompose';
	compiledSql: string;
	dialect: string;
	resolve: (result: string) => void;
	reject: (err: Error) => void;
}

interface PendingSymbolsTask {
	id: number;
	kind: 'symbols';
	dialect: string;
	resolve: (result: DialectSymbols) => void;
	reject: (err: Error) => void;
}

type PendingTask = PendingParseTask | PendingLineageTask | PendingLineageV2Task | PendingDecomposeTask | PendingSymbolsTask;

interface WorkerMessage {
	id?: number;
	ready?: boolean;
	result?: ParseResult;
	lineageResult?: string;
	decomposeResult?: string;
	symbolsResult?: string;
	error?: string;
}

interface WorkerState {
	worker: Worker;
	idle: boolean;
	/** Resolves when the worker has finished loading Pyodide and is ready. */
	ready: Promise<void>;
}

export interface PoolOptions {
	/** Workers to spin up eagerly at construction. Default: min(4, maxWorkers). */
	minWorkers?: number;
	/** Maximum workers allowed. Default: max(1, cpus-2) — reserves 2 cores for VS Code and other processes. */
	maxWorkers?: number;
	/** Optional logger — if provided, worker errors/timeouts are forwarded here instead of console.error. */
	logger?: { warn(msg: string): void };
	/** Override the worker script path. Default: dist/pyodide-worker.js. Used by tests to inject a fake worker. */
	workerScript?: string;
	/** Extra workerData fields merged into every spawned Worker. Used by tests to drive fake-worker scenarios. */
	extraWorkerData?: Record<string, unknown>;
}

/**
 * Thread pool of Pyodide workers.  Each worker runs its own Pyodide instance
 * in a dedicated OS thread, giving true CPU parallelism across cores.
 *
 * - `minWorkers` threads are spawned immediately in parallel at construction.
 * - Additional workers are spawned on demand (up to `maxWorkers`) when all
 *   current workers are busy and the queue is non-empty.
 * - `await pool.ready()` waits for all initial workers to finish loading.
 * - Implements `SqlParser` — drop-in replacement for `PyodideSqlParser`.
 */
export class PyodideWorkerPool implements SqlParser {
	readonly #pyodideDir: string;
	readonly #vendorDir: string;
	readonly #scriptsDir: string;
	readonly #workerScript: string;
	readonly #extraWorkerData: Record<string, unknown> | undefined;
	readonly #minWorkers: number;
	readonly #maxWorkers: number;
	readonly #logger: { warn(msg: string): void };

	#workers: WorkerState[] = [];
	#queue: PendingTask[] = [];
	#nextId = 0;
	#disposed = false;
	/** Per-task message handlers keyed by task id. Drained when the worker replies. */
	#pending = new Map<number, (msg: WorkerMessage) => void>();

	readonly #initialReady: Promise<void>;

	constructor(pyodideDir: string, vendorDir: string, scriptsDir: string, options?: PoolOptions) {
		this.#pyodideDir = pyodideDir;
		this.#vendorDir = vendorDir;
		this.#scriptsDir = scriptsDir;
		if (options?.workerScript) {
			this.#workerScript = options.workerScript;
		} else {
			// In production __dirname === dist/, in tests (tsx) __dirname === src/ftl/.
			// Fall back to dist/ relative to the workspace root when the in-place .js is absent.
			const inPlace = path.join(__dirname, 'pyodide-worker.js');
			this.#workerScript = fs.existsSync(inPlace)
				? inPlace
				: path.join(__dirname, '..', '..', 'dist', 'pyodide-worker.js');
		}
		const defaultMax = Math.max(1, os.cpus().length - 1);
		this.#maxWorkers = options?.maxWorkers ?? defaultMax;
		this.#minWorkers = options?.minWorkers ?? Math.min(4, this.#maxWorkers);
		// eslint-disable-next-line no-console
		this.#logger = options?.logger ?? { warn: (msg) => console.error(msg) };
		this.#extraWorkerData = options?.extraWorkerData;

		// Spawn initial workers in parallel. allSettled so one crashed worker
		// doesn't prevent ready() from resolving — surviving workers still serve requests.
		const initialWorkers = Array.from({ length: this.#minWorkers }, () => this.#spawnWorker());
		// Race each worker's ready promise against a 30s timeout so a worker that is
		// stuck loading Pyodide (no error, no exit, just frozen) can't hang activation.
		const workerReadyTimeout = 30_000;
		const timedReady = initialWorkers.map(w =>
			Promise.race([
				w.ready,
				new Promise<void>((_, rej) =>
					setTimeout(() => rej(new Error('worker ready timeout')), workerReadyTimeout),
				),
			]),
		);
		this.#initialReady = Promise.allSettled(timedReady).then((results) => {
			const failed = results.filter(r => r.status === 'rejected');
			if (failed.length > 0) {
				for (const r of failed) {
					this.#logger.warn(`[PyodideWorkerPool] worker failed to init: ${(r as PromiseRejectedResult).reason}`);
				}
			}
			if (this.#workers.length === 0) {
				this.#logger.warn('[PyodideWorkerPool] all workers failed — draining pending queue with errors');
				this.#rejectAll(new Error('All Pyodide workers failed to initialize'));
			}
		});
	}

	/** Resolves when all initial workers are loaded and ready to accept tasks. */
	ready(): Promise<void> {
		return this.#initialReady;
	}

	#throwIfDisposed(): void {
		if (this.#disposed) throw new Error('PyodideWorkerPool has been disposed');
	}

	async parse(sql: string, dialect: string, schema?: Record<string, Record<string, string>>): Promise<ParseResult> {
		this.#throwIfDisposed();
		return new Promise<ParseResult>((resolve, reject) => {
			this.#enqueue({
				id: this.#nextId++,
				kind: 'parse',
				sql,
				dialect,
				schemaJson: schema ? JSON.stringify(schema) : '',
				resolve,
				reject,
			});
		});
	}

	async traceLineage(compiledSql: string, columnName: string, dialect: string, schemaJson: string): Promise<string> {
		this.#throwIfDisposed();
		return new Promise<string>((resolve, reject) => {
			this.#enqueue({
				id: this.#nextId++,
				kind: 'lineage',
				compiledSql,
				columnName,
				dialect,
				schemaJson,
				resolve,
				reject,
			});
		});
	}

	async traceLineageV2(sql: string, columnName: string, dialect: string, schemaJson: string): Promise<string> {
		this.#throwIfDisposed();
		return new Promise<string>((resolve, reject) => {
			this.#enqueue({
				id: this.#nextId++,
				kind: 'lineage_v2',
				sql,
				columnName,
				dialect,
				schemaJson,
				resolve,
				reject,
			});
		});
	}

	async decomposeQuery(compiledSql: string, dialect: string): Promise<string> {
		this.#throwIfDisposed();
		return new Promise<string>((resolve, reject) => {
			this.#enqueue({
				id: this.#nextId++,
				kind: 'decompose',
				compiledSql,
				dialect,
				resolve,
				reject,
			});
		});
	}

	async getDialectSymbols(dialect: string): Promise<DialectSymbols> {
		this.#throwIfDisposed();
		return new Promise<DialectSymbols>((resolve, reject) => {
			this.#enqueue({
				id: this.#nextId++,
				kind: 'symbols',
				dialect,
				resolve,
				reject,
			});
		});
	}

	dispose(): void {
		this.#disposed = true;
		for (const state of this.#workers) {
			void state.worker.terminate();
		}
		this.#workers = [];
		const disposedErr = new Error('PyodideWorkerPool disposed');
		// Reject queued (not yet dispatched) tasks.
		for (const task of this.#queue) task.reject(disposedErr);
		this.#queue = [];
		// Reject in-flight tasks too — the workers are gone, so their promises
		// would otherwise hang forever.
		for (const handler of this.#pending.values()) handler({ error: disposedErr.message });
		this.#pending.clear();
	}

	#enqueue(task: PendingTask): void {
		this.#queue.push(task);
		this.#drain();
	}

	#drain(): void {
		if (this.#queue.length === 0) return;

		// Try to find an idle worker.
		const idle = this.#workers.find(w => w.idle);
		if (idle) {
			this.#dispatch(idle, this.#queue.shift()!);
			return;
		}

		// No idle worker — scale up if possible.
		if (this.#workers.length < this.#maxWorkers) {
			const state = this.#spawnWorker();
			// Dispatch once this new worker is ready.
			void state.ready.then(() => {
				if (!this.#disposed && this.#queue.length > 0) {
					this.#dispatch(state, this.#queue.shift()!);
				}
			});
		}
		// Otherwise task stays in queue until a worker finishes its current task.
	}

	#dispatch(state: WorkerState, task: PendingTask): void {
		state.idle = false;

		this.#pending.set(task.id, (msg) => {
			state.idle = true;
			try {
				if (msg.error !== undefined) {
					task.reject(new Error(msg.error));
				} else if (task.kind === 'lineage' || task.kind === 'lineage_v2') {
					if (msg.lineageResult === undefined) {
						task.reject(new Error(`[PyodideWorkerPool] lineage worker returned no lineageResult (msg keys: ${Object.keys(msg).join(',')})`));
					} else {
						(task as PendingLineageTask).resolve(msg.lineageResult);
					}
				} else if (task.kind === 'decompose') {
					if (msg.decomposeResult === undefined) {
						task.reject(new Error(`[PyodideWorkerPool] decompose worker returned no decomposeResult (msg keys: ${Object.keys(msg).join(',')})`));
					} else {
						(task as PendingDecomposeTask).resolve(msg.decomposeResult);
					}
				} else if (task.kind === 'symbols') {
					if (msg.symbolsResult === undefined) {
						task.reject(new Error(`[PyodideWorkerPool] symbols worker returned no symbolsResult (msg keys: ${Object.keys(msg).join(',')})`));
					} else {
						const payload = JSON.parse(msg.symbolsResult) as { functions: string[]; keywordTokenTypes: string[]; types: string[] };
						(task as PendingSymbolsTask).resolve({
							functions: new Set(payload.functions),
							keywordTokenTypes: new Set(payload.keywordTokenTypes),
							types: new Set(payload.types),
						});
					}
				} else {
					if (msg.result === undefined) {
						task.reject(new Error(`[PyodideWorkerPool] parse worker returned no result (msg keys: ${Object.keys(msg).join(',')})`));
					} else {
						(task as PendingParseTask).resolve(msg.result);
					}
				}
			} catch (err) {
				const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
				task.reject(new Error(`[PyodideWorkerPool] onMessage crash (task.kind=${task.kind}, msg keys=${Object.keys(msg).join(',')}): ${detail}`));
			}

			if (!this.#disposed && this.#queue.length > 0) {
				this.#dispatch(state, this.#queue.shift()!);
			}
		});

		if (task.kind === 'lineage') {
			state.worker.postMessage({
				id: task.id,
				type: 'lineage',
				compiledSql: task.compiledSql,
				columnName: task.columnName,
				dialect: task.dialect,
				schemaJson: task.schemaJson,
			});
		} else if (task.kind === 'lineage_v2') {
			state.worker.postMessage({
				id: task.id,
				type: 'lineage_v2',
				sql: task.sql,
				columnName: task.columnName,
				dialect: task.dialect,
				schemaJson: task.schemaJson,
			});
		} else if (task.kind === 'decompose') {
			state.worker.postMessage({
				id: task.id,
				type: 'decompose',
				compiledSql: task.compiledSql,
				dialect: task.dialect,
			});
		} else if (task.kind === 'symbols') {
			state.worker.postMessage({
				id: task.id,
				type: 'symbols',
				dialect: task.dialect,
			});
		} else {
			state.worker.postMessage({
				id: task.id,
				sql: task.sql,
				dialect: task.dialect,
				schemaJson: task.schemaJson,
			});
		}
	}

	#spawnWorker(): WorkerState {
		const worker = new Worker(this.#workerScript, {
			workerData: {
				pyodideDir: this.#pyodideDir,
				vendorDir: this.#vendorDir,
				scriptsDir: this.#scriptsDir,
				...this.#extraWorkerData,
			},
		});

		let resolveReady!: () => void;
		let rejectReady!: (err: Error) => void;
		const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });
		// Track ready settlement so post-resolve exit/error events don't queue
		// a "phantom" rejection on the already-resolved promise — Node otherwise
		// surfaces it as an unhandled rejection in test runners.
		let readySettled = false;
		const settleReady = (err?: Error): void => {
			if (readySettled) return;
			// After dispose nothing is observing `ready` — rejecting it would surface
			// as an unhandled rejection in Node when the worker exit event fires post-dispose.
			if (err && this.#disposed) return;
			readySettled = true;
			if (err) rejectReady(err); else resolveReady();
		};

		const state: WorkerState = { worker, idle: false, ready };

		// Single persistent message listener handles the ready signal and every
		// subsequent task reply by routing on `msg.id` through the #pending map.
		worker.on('message', (msg: WorkerMessage) => {
			if (msg.ready) {
				state.idle = true;
				settleReady();
				// Drain in case tasks were queued while this worker was loading.
				this.#drain();
				return;
			}
			if (msg.id === undefined) return;
			const handler = this.#pending.get(msg.id);
			if (!handler) return; // stale or unknown — drop
			this.#pending.delete(msg.id);
			handler(msg);
		});

		worker.on('error', (err: Error) => {
			// Remove faulted worker from pool and unblock ready() so startup doesn't hang.
			this.#workers = this.#workers.filter(w => w !== state);
			settleReady(err);
			void worker.terminate();
			this.#logger.warn(`[PyodideWorkerPool] worker error: ${err.message}`);
			if (this.#workers.length === 0) {
				this.#logger.warn('[PyodideWorkerPool] all workers gone — draining pending queue with errors');
				this.#rejectAll(new Error('All Pyodide workers failed'));
			}
		});

		worker.once('exit', (code: number) => {
			// Worker exited without sending { ready: true } — reject so allSettled can proceed.
			this.#workers = this.#workers.filter(w => w !== state);
			settleReady(new Error(`worker exited unexpectedly with code ${code}`));
			if (this.#workers.length === 0 && this.#queue.length > 0) {
				this.#logger.warn('[PyodideWorkerPool] last worker exited — draining pending queue with errors');
				this.#rejectAll(new Error('All Pyodide workers exited'));
			}
		});

		this.#workers.push(state);
		return state;
	}

	#rejectAll(err: Error): void {
		const pending = this.#queue.splice(0);
		for (const task of pending) {
			task.reject(err);
		}
	}
}
