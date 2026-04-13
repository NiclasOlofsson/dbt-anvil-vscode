import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ParseResult } from './parse-result';
import type { SqlParser } from './sql-parser';

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

type PendingTask = PendingParseTask | PendingLineageTask | PendingLineageV2Task | PendingDecomposeTask;

interface WorkerState {
	worker: Worker;
	idle: boolean;
	/** Resolves when the worker has finished loading Pyodide and is ready. */
	ready: Promise<void>;
}

export interface PoolOptions {
	/** Workers to spin up eagerly at construction. Default: 4. */
	minWorkers?: number;
	/** Maximum workers allowed. Default: os.cpus().length. */
	maxWorkers?: number;
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
	readonly #minWorkers: number;
	readonly #maxWorkers: number;

	#workers: WorkerState[] = [];
	#queue: PendingTask[] = [];
	#nextId = 0;
	#disposed = false;

	readonly #initialReady: Promise<void>;

	constructor(pyodideDir: string, vendorDir: string, scriptsDir: string, options?: PoolOptions) {
		this.#pyodideDir = pyodideDir;
		this.#vendorDir = vendorDir;
		this.#scriptsDir = scriptsDir;
		// In production __dirname === dist/, in tests (tsx) __dirname === src/ftl/.
		// Fall back to dist/ relative to the workspace root when the in-place .js is absent.
		const inPlace = path.join(__dirname, 'pyodide-worker.js');
		this.#workerScript = fs.existsSync(inPlace)
			? inPlace
			: path.join(__dirname, '..', '..', 'dist', 'pyodide-worker.js');
		this.#minWorkers = options?.minWorkers ?? 4;
		this.#maxWorkers = options?.maxWorkers ?? os.cpus().length;

		// Spawn initial workers in parallel. allSettled so one crashed worker
		// doesn't prevent ready() from resolving — surviving workers still serve requests.
		const initialWorkers = Array.from({ length: this.#minWorkers }, () => this.#spawnWorker());
		this.#initialReady = Promise.allSettled(initialWorkers.map(w => w.ready)).then(() => undefined);
	}

	/** Resolves when all initial workers are loaded and ready to accept tasks. */
	ready(): Promise<void> {
		return this.#initialReady;
	}

	async parse(sql: string, dialect: string, schema?: Record<string, Record<string, string>>): Promise<ParseResult> {
		if (this.#disposed) {
			throw new Error('PyodideWorkerPool has been disposed');
		}
		return new Promise<ParseResult>((resolve, reject) => {
			const task: PendingParseTask = {
				id: this.#nextId++,
				kind: 'parse',
				sql,
				dialect,
				schemaJson: schema ? JSON.stringify(schema) : '',
				resolve,
				reject,
			};
			this.#queue.push(task);
			this.#drain();
		});
	}

	traceLineage(compiledSql: string, columnName: string, dialect: string, schemaJson: string): Promise<string> {
		if (this.#disposed) {
			throw new Error('PyodideWorkerPool has been disposed');
		}
		return new Promise<string>((resolve, reject) => {
			const task: PendingLineageTask = {
				id: this.#nextId++,
				kind: 'lineage',
				compiledSql,
				columnName,
				dialect,
				schemaJson,
				resolve,
				reject,
			};
			this.#queue.push(task);
			this.#drain();
		});
	}

	traceLineageV2(sql: string, columnName: string, dialect: string, schemaJson: string): Promise<string> {
		if (this.#disposed) {
			throw new Error('PyodideWorkerPool has been disposed');
		}
		return new Promise<string>((resolve, reject) => {
			const task: PendingLineageV2Task = {
				id: this.#nextId++,
				kind: 'lineage_v2',
				sql,
				columnName,
				dialect,
				schemaJson,
				resolve,
				reject,
			};
			this.#queue.push(task);
			this.#drain();
		});
	}

	decomposeQuery(compiledSql: string, dialect: string): Promise<string> {
		if (this.#disposed) {
			throw new Error('PyodideWorkerPool has been disposed');
		}
		return new Promise<string>((resolve, reject) => {
			const task: PendingDecomposeTask = {
				id: this.#nextId++,
				kind: 'decompose',
				compiledSql,
				dialect,
				resolve,
				reject,
			};
			this.#queue.push(task);
			this.#drain();
		});
	}

	dispose(): void {
		this.#disposed = true;
		for (const state of this.#workers) {
			void state.worker.terminate();
		}
		this.#workers = [];
		// Reject any pending tasks.
		for (const task of this.#queue) {
			task.reject(new Error('PyodideWorkerPool disposed'));
		}
		this.#queue = [];
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
				if (this.#queue.length > 0) {
					this.#dispatch(state, this.#queue.shift()!);
				}
			});
		}
		// Otherwise task stays in queue until a worker finishes its current task.
	}

	#dispatch(state: WorkerState, task: PendingTask): void {
		state.idle = false;

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
		} else {
			state.worker.postMessage({
				id: task.id,
				sql: task.sql,
				dialect: task.dialect,
				schemaJson: task.schemaJson,
			});
		}

		const onMessage = (msg: { id: number; result?: ParseResult; lineageResult?: string; decomposeResult?: string; error?: string }) => {
			try {
				if (msg.id !== task.id) return;
				state.worker.off('message', onMessage);
				state.idle = true;

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
				} else {
					if (msg.result === undefined) {
						task.reject(new Error(`[PyodideWorkerPool] parse worker returned no result (msg keys: ${Object.keys(msg).join(',')})`));
					} else {
						(task as PendingParseTask).resolve(msg.result);
					}
				}

				if (this.#queue.length > 0) {
					this.#dispatch(state, this.#queue.shift()!);
				}
			} catch (err) {
				const detail = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
				task.reject(new Error(`[PyodideWorkerPool] onMessage crash (task.kind=${task.kind}, msg keys=${Object.keys(msg).join(',')}): ${detail}`));
			}
		};

		state.worker.on('message', onMessage);
	}

	#spawnWorker(): WorkerState {
		const worker = new Worker(this.#workerScript, {
			workerData: {
				pyodideDir: this.#pyodideDir,
				vendorDir: this.#vendorDir,
				scriptsDir: this.#scriptsDir,
			},
		});

		let resolveReady!: () => void;
		let rejectReady!: (err: Error) => void;
		const ready = new Promise<void>((res, rej) => { resolveReady = res; rejectReady = rej; });

		const state: WorkerState = { worker, idle: false, ready };

		worker.once('message', (msg: { ready?: boolean }) => {
			if (msg.ready) {
				state.idle = true;
				resolveReady();
				// Drain in case tasks were queued while this worker was loading.
				this.#drain();
			}
		});

		worker.on('error', (err: Error) => {
			// Remove faulted worker from pool and unblock ready() so startup doesn't hang.
			this.#workers = this.#workers.filter(w => w !== state);
			rejectReady(err);
			void worker.terminate();
			console.error(`[PyodideWorkerPool] worker error: ${(err as Error).message}`);
		});

		this.#workers.push(state);
		return state;
	}
}
