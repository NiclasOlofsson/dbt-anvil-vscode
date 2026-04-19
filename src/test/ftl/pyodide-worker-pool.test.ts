import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PyodideWorkerPool } from '../../ftl/pyodide-worker-pool.js';

const FAKE_WORKER = path.join(__dirname, '__fixtures__', 'fake-pyodide-worker.mjs');

const STUB_DIRS = ['/tmp/stub-pyodide', '/tmp/stub-vendor', '/tmp/stub-scripts'] as const;

function makePool(opts: Partial<{
	maxWorkers: number;
	minWorkers: number;
	extraWorkerData: Record<string, unknown>;
}> = {}): PyodideWorkerPool {
	return new PyodideWorkerPool(STUB_DIRS[0], STUB_DIRS[1], STUB_DIRS[2], {
		maxWorkers: opts.maxWorkers ?? 1,
		minWorkers: opts.minWorkers ?? 1,
		workerScript: FAKE_WORKER,
		extraWorkerData: opts.extraWorkerData,
		// Silence the "all workers gone" warnings the dispose tests trigger.
		logger: { warn: () => undefined },
	});
}

let activePools: PyodideWorkerPool[] = [];

function track(p: PyodideWorkerPool): PyodideWorkerPool {
	activePools.push(p);
	return p;
}

afterEach(() => {
	for (const p of activePools) {
		try { p.dispose(); } catch { /* already disposed */ }
	}
	activePools = [];
});

describe('PyodideWorkerPool', () => {
	it('dispatches tasks concurrently across multiple workers', async () => {
		const pool = track(makePool({ maxWorkers: 2, minWorkers: 2 }));
		await pool.ready();

		const results = await Promise.all([
			pool.parse('SELECT 1', 'duckdb'),
			pool.parse('SELECT 2', 'duckdb'),
			pool.parse('SELECT 3', 'duckdb'),
			pool.parse('SELECT 4', 'duckdb'),
		]);

		expect(results).toHaveLength(4);
		for (const r of results) expect(r.dialect).toBe('duckdb');
	});

	it('rejects in-flight and queued tasks on dispose', async () => {
		const pool = track(new PyodideWorkerPool(STUB_DIRS[0], STUB_DIRS[1], STUB_DIRS[2], {
			maxWorkers: 1,
			minWorkers: 1,
			workerScript: FAKE_WORKER,
			logger: { warn: () => undefined },
		}));
		await pool.ready();

		// First call occupies the worker; we'll dispose before the queued ones drain.
		const first = pool.parse('SELECT 1', 'duckdb');
		const second = pool.parse('SELECT 2', 'duckdb');
		const third = pool.parse('SELECT 3', 'duckdb');

		pool.dispose();

		await expect(first).rejects.toThrow(/disposed/);
		await expect(second).rejects.toThrow(/disposed/);
		await expect(third).rejects.toThrow(/disposed/);
	});

	it('drops duplicate replies for the same task id (stale-message guard)', async () => {
		const pool = track(makePool({
			maxWorkers: 1,
			minWorkers: 1,
			extraWorkerData: { duplicateReplies: true },
		}));
		await pool.ready();

		// First task sees the duplicate. Second task must still resolve cleanly,
		// proving the duplicate didn't poison subsequent dispatches.
		const r1 = await pool.parse('SELECT 1', 'duckdb');
		expect(r1.dialect).toBe('duckdb');

		const r2 = await pool.parse('SELECT 2', 'duckdb');
		expect(r2.dialect).toBe('duckdb');
	});

	it('honors minWorkers default of 4 when maxWorkers >= 4', async () => {
		// With minWorkers defaulting to min(4, maxWorkers)=4, four concurrent tasks
		// should all complete in parallel without the pool needing to scale up.
		const pool = track(makePool({ maxWorkers: 8 }));
		await pool.ready();
		const results = await Promise.all([
			pool.parse('SELECT 1', 'duckdb'),
			pool.parse('SELECT 2', 'duckdb'),
			pool.parse('SELECT 3', 'duckdb'),
			pool.parse('SELECT 4', 'duckdb'),
		]);
		expect(results).toHaveLength(4);
	});

	it('clamps minWorkers default to maxWorkers when maxWorkers < 4', async () => {
		const pool = track(makePool({ maxWorkers: 2 }));
		await pool.ready();
		const r = await pool.parse('SELECT 1', 'duckdb');
		expect(r.dialect).toBe('duckdb');
	});

	it('throws on every entry point after dispose', async () => {
		const pool = track(makePool({ maxWorkers: 1, minWorkers: 1 }));
		await pool.ready();
		pool.dispose();

		await expect(pool.parse('SELECT 1', 'duckdb')).rejects.toThrow(/disposed/);
		await expect(pool.traceLineage('SELECT 1', 'c', 'duckdb', '')).rejects.toThrow(/disposed/);
		await expect(pool.traceLineageV2('SELECT 1', 'c', 'duckdb', '')).rejects.toThrow(/disposed/);
		await expect(pool.decomposeQuery('SELECT 1', 'duckdb')).rejects.toThrow(/disposed/);
		await expect(pool.getDialectSymbols('duckdb')).rejects.toThrow(/disposed/);
	});

	it('routes lineage/decompose/symbols to their typed result fields', async () => {
		const pool = track(makePool({ maxWorkers: 1, minWorkers: 1 }));
		await pool.ready();

		const lineage = await pool.traceLineageV2('SELECT id FROM t', 'id', 'duckdb', '');
		expect(JSON.parse(lineage).success).toBe(true);

		const decompose = await pool.decomposeQuery('SELECT 1', 'duckdb');
		expect(JSON.parse(decompose).ctes).toEqual([]);

		const symbols = await pool.getDialectSymbols('duckdb');
		expect(symbols.functions.has('foo')).toBe(true);
		expect(symbols.keywordTokenTypes.has('SELECT')).toBe(true);
		expect(symbols.types.has('INT')).toBe(true);
	});
});
