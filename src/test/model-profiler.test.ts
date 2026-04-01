import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CteInfo } from '../services/parse-service';
import type { DatabaseProvider, QueryResult } from '../providers/database/database-provider';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DbtQueryService } from '../services/dbt-query-service';
import { ModelProfiler } from '../dbt/model-profiler';
import { createMockLogger } from './helpers';

// ---------------------------------------------------------------------------
// Stub factories
// ---------------------------------------------------------------------------

function makeDbtQueryService(ctes: Partial<CteInfo>[] = [], compiledSql = SIMPLE_SQL): DbtQueryService {
	const cteList = ctes.map((c, i) => ({
		name: c.name ?? `cte_${i}`,
		line: c.line ?? i,
		endLine: c.endLine ?? i,
		columns: c.columns ?? [],
	}));
	return {
		getCompiledCtes: vi.fn().mockResolvedValue({ compiledSql, ctes: cteList }),
		buildCteSql: vi.fn(),
	} as unknown as DbtQueryService;
}

function makeQueryResult(count: number): QueryResult {
	return { columns: ['_profile_count'], rows: [{ _profile_count: count }], rowCount: 1, executionTimeMs: 0 };
}

function makeDbProvider(rowCounts: (number | Error)[]): DatabaseProvider {
	let callIndex = 0;
	const query = vi.fn(async () => {
		const entry = rowCounts[callIndex++];
		if (entry instanceof Error) throw entry;
		return makeQueryResult(entry);
	});
	return { query } as unknown as DatabaseProvider;
}

function makeIndexer(
	filePath: string,
	uniqueId: string,
	name: string,
	projectDir = '/project',
): ManifestIndexer {
	return {
		findModelByFilePath: vi.fn().mockReturnValue(uniqueId),
		getRawNode: vi.fn().mockReturnValue({
			name,
			resource_type: 'model',
			original_file_path: `models/${name}.sql`,
			unique_id: uniqueId,
		}),
		findModelsByName: vi.fn().mockReturnValue([{ uniqueId }]),
		projectDir,
		index: { adapterType: 'ansi', models: new Map(), sources: new Map() },
	} as unknown as ManifestIndexer;
}

function makeDocument(fileName: string, languageId = 'jinja-sql', text = SIMPLE_SQL) {
	return {
		fileName,
		languageId,
		uri: { toString: () => `file://${fileName}` },
		getText: () => text,
	} as unknown as import('vscode').TextDocument;
}

// ---------------------------------------------------------------------------
// Test SQL — two real CTEs + final SELECT.
// Line 0: WITH alpha AS (SELECT 1 AS val),    endLine 0
// Line 1:      beta  AS (SELECT * FROM alpha)  endLine 1
// Line 2: SELECT * FROM beta                   (final SELECT)
// ---------------------------------------------------------------------------
const SIMPLE_SQL = [
	'WITH alpha AS (SELECT 1 AS val),',
	'     beta  AS (SELECT * FROM alpha)',
	'SELECT * FROM beta',
].join('\n');

// ---------------------------------------------------------------------------
// Tests: basic state management
// ---------------------------------------------------------------------------

describe('ModelProfiler — initial state', () => {
	let profiler: ModelProfiler;

	beforeEach(() => {
		profiler = new ModelProfiler(
			makeDbtQueryService(),
			makeDbProvider([]),
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);
	});

	it('returns undefined for an unknown model id', () => {
		expect(profiler.getResult('model.unknown')).toBeUndefined();
	});

	it('getAllResults is empty initially', () => {
		expect(profiler.getAllResults()).toHaveLength(0);
	});

	it('getResultForFile returns undefined when file not in indexer', () => {
		const indexer = makeIndexer('/model.sql', 'model.orders', 'orders');
		(indexer.findModelByFilePath as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
		const p = new ModelProfiler(
			makeDbtQueryService(),
			makeDbProvider([]),
			indexer,
			createMockLogger(),
		);
		expect(p.getResultForFile('/other.sql')).toBeUndefined();
	});

	it('clearAll removes all results', async () => {
		// Quick profile to populate results
		const dbProvider = makeDbProvider([10, 20, 30]);
		const p = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }, { name: 'beta', line: 1 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);
		await p.profileDocument(makeDocument('/model.sql'));
		expect(p.getAllResults()).toHaveLength(1);
		p.clearAll();
		expect(p.getAllResults()).toHaveLength(0);
	});

	it('clearResult removes a specific model', async () => {
		const dbProvider = makeDbProvider([5, 10, 50]);
		const p = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }, { name: 'beta', line: 1 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);
		await p.profileDocument(makeDocument('/model.sql'));
		p.clearResult('model.orders');
		expect(p.getResult('model.orders')).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Tests: profileDocument — success path
// ---------------------------------------------------------------------------

describe('ModelProfiler — profileDocument success', () => {
	it('includes one CteProfile per found CTE', async () => {
		// alpha and beta are both present in SIMPLE_SQL, beta CTE depends on alpha
		const dbProvider = makeDbProvider([
			1,   // alpha query row count
			10,  // beta  query row count
			100, // full model row count
		]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }, { name: 'beta', line: 1 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));

		expect(result.status).toBe('complete');
		expect(result.modelName).toBe('orders');
		expect(result.cteProfiles).toHaveLength(2);
		expect(result.cteProfiles.map(p => p.name)).toEqual(['alpha', 'beta']);
	});

	it('rowCount on each CTE comes from COUNT(*) query', async () => {
		const dbProvider = makeDbProvider([0, 42, 7, 999]); // 0 = warmup
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }, { name: 'beta', line: 1 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		expect(result.cteProfiles[0].rowCount).toBe(42);
		expect(result.cteProfiles[1].rowCount).toBe(7);
		expect(result.totalRowCount).toBe(999);
	});

	it('fractionOfTotal is a finite number for each CTE', async () => {
		const dbProvider = makeDbProvider([5, 10, 100]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }, { name: 'beta', line: 1 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		for (const p of result.cteProfiles) {
			expect(Number.isFinite(p.fractionOfTotal)).toBe(true);
		}
	});

	it('marginalTimeMs[i] is a finite number for all CTEs', async () => {
		const dbProvider = makeDbProvider([1, 2, 10]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }, { name: 'beta', line: 1 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		for (const p of result.cteProfiles) {
			expect(Number.isFinite(p.marginalTimeMs)).toBe(true);
		}
	});

	it('fires onProfileStarted before any queries run', async () => {
		const started: string[] = [];
		const dbProvider = makeDbProvider([1, 2, 10]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);
		profiler.onProfileStarted(uid => started.push(uid));
		await profiler.profileDocument(makeDocument('/model.sql'));
		expect(started).toContain('model.orders');
	});

	it('fires onProfileComplete with running placeholder and then complete result', async () => {
		const statuses: string[] = [];
		const dbProvider = makeDbProvider([1, 2, 10]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);
		profiler.onProfileComplete(r => statuses.push(r.status));
		await profiler.profileDocument(makeDocument('/model.sql'));
		expect(statuses[0]).toBe('running');
		expect(statuses[statuses.length - 1]).toBe('complete');
	});

	it('stores the result so getResult() returns it after profiling', async () => {
		const dbProvider = makeDbProvider([1, 2, 10]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);
		await profiler.profileDocument(makeDocument('/model.sql'));
		expect(profiler.getResult('model.orders')).toBeDefined();
		expect(profiler.getResult('model.orders')?.status).toBe('complete');
	});

	it('getResultForFile resolves via indexer', async () => {
		const dbProvider = makeDbProvider([1, 2, 10]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);
		await profiler.profileDocument(makeDocument('/model.sql'));
		expect(profiler.getResultForFile('/model.sql')).toBeDefined();
	});

	it('skips CTEs whose query throws but still returns partial results', async () => {
		// alpha query will throw, but ghost's endLine position still generates a query
		const dbProvider = makeDbProvider([
			0,                              // warmup
			new Error('network timeout'),   // alpha fails
			5,                              // ghost succeeds
			10,                             // full model
		]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }, { name: 'ghost', line: 1 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		expect(result.status).toBe('complete');
		// alpha was skipped (query threw); ghost succeeded
		expect(result.cteProfiles.map(p => p.name)).toEqual(['ghost']);
	});
});

// ---------------------------------------------------------------------------
// Tests: profileDocument — error handling
// ---------------------------------------------------------------------------

describe('ModelProfiler — error handling', () => {
	it('throws when file is not a manifest model', async () => {
		const indexer = makeIndexer('/model.sql', 'model.orders', 'orders');
		(indexer.findModelByFilePath as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
		const profiler = new ModelProfiler(
			makeDbtQueryService(),
			makeDbProvider([]),
			indexer,
			createMockLogger(),
		);

		await expect(profiler.profileDocument(makeDocument('/model.sql'))).rejects.toThrow('manifest-indexed');
	});

	it('throws when manifest node is not a model', async () => {
		const indexer = makeIndexer('/model.sql', 'source.orders', 'orders');
		(indexer.getRawNode as ReturnType<typeof vi.fn>).mockReturnValue({
			name: 'orders',
			resource_type: 'source',
			original_file_path: 'models/orders.sql',
			unique_id: 'source.orders',
		});
		const profiler = new ModelProfiler(
			makeDbtQueryService(),
			makeDbProvider([]),
			indexer,
			createMockLogger(),
		);

		await expect(profiler.profileDocument(makeDocument('/model.sql'))).rejects.toThrow('not a model');
	});

	it('skips a CTE whose query throws — does not abort the whole profiling run', async () => {
		const dbProvider = makeDbProvider([
			0,                             // warmup
			new Error('network timeout'),  // alpha fails
			5,                             // full model still succeeds
		]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		// alpha was skipped (query threw), but the full model query succeeded
		expect(result.status).toBe('complete');
		expect(result.cteProfiles).toHaveLength(0);
		expect(result.totalRowCount).toBe(5);
	});
});

// ---------------------------------------------------------------------------
// Tests: count extraction — exercise through profileDocument
// ---------------------------------------------------------------------------

describe('ModelProfiler — COUNT(*) result extraction', () => {
	it('handles _PROFILE_COUNT (uppercase) from case-folding databases', async () => {
		const dbProvider = {
			query: vi.fn()
				.mockResolvedValueOnce({ columns: ['_PROFILE_COUNT'], rows: [{ _PROFILE_COUNT: 0 }], rowCount: 1, executionTimeMs: 0 }) // warmup
				.mockResolvedValueOnce({ columns: ['_PROFILE_COUNT'], rows: [{ _PROFILE_COUNT: 77 }], rowCount: 1, executionTimeMs: 0 })
				.mockResolvedValueOnce({ columns: ['_PROFILE_COUNT'], rows: [{ _PROFILE_COUNT: 200 }], rowCount: 1, executionTimeMs: 0 }),
		} as unknown as DatabaseProvider;

		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		expect(result.cteProfiles[0].rowCount).toBe(77);
		expect(result.totalRowCount).toBe(200);
	});

	it('falls back to first column value when alias is missing', async () => {
		const dbProvider = {
			query: vi.fn()
				.mockResolvedValueOnce({ columns: ['cnt'], rows: [{ cnt: 0 }], rowCount: 1, executionTimeMs: 0 }) // warmup
				.mockResolvedValueOnce({ columns: ['cnt'], rows: [{ cnt: 42 }], rowCount: 1, executionTimeMs: 0 })
				.mockResolvedValueOnce({ columns: ['cnt'], rows: [{ cnt: 1000 }], rowCount: 1, executionTimeMs: 0 }),
		} as unknown as DatabaseProvider;

		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		expect(result.cteProfiles[0].rowCount).toBe(42);
	});

	it('returns 0 when row is undefined', async () => {
		const dbProvider = {
			query: vi.fn()
				.mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }) // warmup
				.mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 })
				.mockResolvedValueOnce({ columns: [], rows: [], rowCount: 0, executionTimeMs: 0 }),
		} as unknown as DatabaseProvider;

		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		expect(result.cteProfiles[0].rowCount).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Tests: CteProfile structure
// ---------------------------------------------------------------------------

describe('ModelProfiler — metadata propagation', () => {
	it('CteProfile carries name and timing only — no line positions', async () => {
		const dbProvider = makeDbProvider([5, 50]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 7 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		expect(result.cteProfiles[0].name).toBe('alpha');
		expect(result.cteProfiles[0]).not.toHaveProperty('definitionLine');
		expect(result.cteProfiles[0]).not.toHaveProperty('endLine');
	});

	it('records modelName and sourceFilePath in the result', async () => {
		const dbProvider = makeDbProvider([1, 5]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/path/to/orders.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/path/to/orders.sql'));
		expect(result.modelName).toBe('orders');
		expect(result.sourceFilePath).toBe('/path/to/orders.sql');
	});

	it('timestamp is set to approximately now', async () => {
		const before = Date.now();
		const dbProvider = makeDbProvider([1, 5]);
		const profiler = new ModelProfiler(
			makeDbtQueryService([{ name: 'alpha', line: 0 }]),
			dbProvider,
			makeIndexer('/model.sql', 'model.orders', 'orders'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql'));
		const after = Date.now();
		expect(result.timestamp).toBeGreaterThanOrEqual(before);
		expect(result.timestamp).toBeLessThanOrEqual(after);
	});
});

// ---------------------------------------------------------------------------
// Tests: no CTEs case
// ---------------------------------------------------------------------------

describe('ModelProfiler — no CTEs', () => {
	const SIMPLE_SELECT = 'SELECT 1 AS id';

	it('returns complete status with empty cteProfiles and the full model timing', async () => {
		const dbProvider = makeDbProvider([0, 99]); // 0 = warmup
		const profiler = new ModelProfiler(
			makeDbtQueryService([]), // no CTEs
			dbProvider,
			makeIndexer('/model.sql', 'model.dim_date', 'dim_date'),
			createMockLogger(),
		);

		const result = await profiler.profileDocument(makeDocument('/model.sql', 'jinja-sql', SIMPLE_SELECT));
		expect(result.cteProfiles).toHaveLength(0);
		expect(result.totalRowCount).toBe(99);
		expect(result.status).toBe('complete');
	});
});
