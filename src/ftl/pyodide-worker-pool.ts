import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';
import type { ParseResult } from './parse-result';
import type { SqlParser } from './sql-parser';

interface PendingTask {
    id: number;
    sql: string;
    dialect: string;
    schemaJson: string;
    resolve: (result: ParseResult) => void;
    reject: (err: Error) => void;
}

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

        // Spawn initial workers in parallel.
        const initialWorkers = Array.from({ length: this.#minWorkers }, () => this.#spawnWorker());
        this.#initialReady = Promise.all(initialWorkers.map(w => w.ready)).then(() => undefined);
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
            const task: PendingTask = {
                id: this.#nextId++,
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
        state.worker.postMessage({
            id: task.id,
            sql: task.sql,
            dialect: task.dialect,
            schemaJson: task.schemaJson,
        });

        const onMessage = (msg: { id: number; result?: ParseResult; error?: string }) => {
            if (msg.id !== task.id) return;
            state.worker.off('message', onMessage);
            state.idle = true;

            if (msg.error !== undefined) {
                task.reject(new Error(msg.error));
            } else {
                task.resolve(msg.result!);
            }

            // Pick up next queued task, if any.
            if (this.#queue.length > 0) {
                this.#dispatch(state, this.#queue.shift()!);
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
        const ready = new Promise<void>((res) => { resolveReady = res; });

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
            // Remove faulted worker from pool.
            this.#workers = this.#workers.filter(w => w !== state);
            void worker.terminate();
            console.error(`[PyodideWorkerPool] worker error: ${(err as Error).message}`);
        });

        this.#workers.push(state);
        return state;
    }
}
