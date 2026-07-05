/**
 * Un-mocked integration coverage for the column-lineage tool on the LIVE engine.
 *
 * `column-lineage.test.ts` mocks the parser (`traceLineageV2: vi.fn().mockResolvedValue(...)`),
 * so it validates the tool's JSON-shaping but never runs a real parse — which is exactly why
 * the lineage 0-deps bug shipped green: the tool reads the RAW jinja model file and the real
 * `SqllensDocumentParser.traceLineageV2` parsed it un-blanked, resolving nothing. These tests
 * wire the tool to a REAL `SqllensDocumentParser` and feed it a raw jinja model through
 * `fs.readFileSync`, exercising the exact seam that broke. They FAIL if the raw-jinja handling
 * (blankJinja before the lineage parse) regresses.
 */
import { describe, it, expect, vi } from 'vitest';
import { GetColumnLineageTool } from '../../tools/get-column-lineage';
import { SqllensDocumentParser } from '../../ftl/sqllens/document-parser';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import { createMockLogger, createMockCompileCache } from '../helpers';

// A raw jinja model (what the tool actually reads off disk via original_file_path) —
// a ref()'d table with an alias, the shape that returned 0 deps before the fix.
// vi.hoisted so it's available inside the hoisted vi.mock('fs') factory below.
const { CUSTOMERS_SQL } = vi.hoisted(() => ({
	CUSTOMERS_SQL: [
		'select',
		'\to.order_id as gold_orderkey,',
		'\to.amount as amount',
		'from {{ ref(\'stg_orders\') }} o',
	].join('\n'),
}));

vi.mock('fs', () => {
	const readFileSync = vi.fn().mockReturnValue(CUSTOMERS_SQL);
	return { default: { readFileSync }, readFileSync };
});

const logger = createMockLogger();
const compileCache = createMockCompileCache(CUSTOMERS_SQL);
const describeCache = { columns: vi.fn().mockResolvedValue(undefined) } as never;

/** Minimal indexer: the traced model + its one upstream, so ref('stg_orders') resolves. */
function makeIndexer(): ManifestIndexer {
	const rawNodes: Record<string, Record<string, unknown>> = {
		'model.p.customers': {
			unique_id: 'model.p.customers',
			name: 'customers',
			resource_type: 'model',
			schema: 'main',
			database: 'dev',
			original_file_path: 'models/customers.sql',
			columns: {},
		},
		'model.p.stg_orders': {
			unique_id: 'model.p.stg_orders',
			name: 'stg_orders',
			resource_type: 'model',
			schema: 'main',
			database: 'dev',
			alias: 'stg_orders',
			original_file_path: 'models/stg_orders.sql',
			columns: { order_id: { data_type: 'bigint' }, amount: { data_type: 'double' } },
		},
	};
	const models = new Map<string, { uniqueId: string; name: string; schema: string }>([
		['model.p.customers', { uniqueId: 'model.p.customers', name: 'customers', schema: 'main' }],
		['model.p.stg_orders', { uniqueId: 'model.p.stg_orders', name: 'stg_orders', schema: 'main' }],
	]);
	return {
		// _buildRelationLookup + column resolution read .index (models/sources for the
		// relation→uid map; parentMap/childMap for the recursive column walk).
		index: {
			models,
			sources: new Map(),
			macros: new Map(),
			nodesByName: new Map([['customers', ['model.p.customers']], ['stg_orders', ['model.p.stg_orders']]]),
			parentMap: new Map([['model.p.customers', ['model.p.stg_orders']]]),
			childMap: new Map([['model.p.stg_orders', ['model.p.customers']]]),
			dbtVersion: '1.8.0',
			adapterType: 'databricks',
			buildTime: new Date(),
		},
		projectDir: '/project',
		adapterType: 'databricks',
		getRawNode: vi.fn((uid: string) => rawNodes[uid]),
		getLineage: vi.fn(() => ({
			upstream: [{ uniqueId: 'model.p.stg_orders', name: 'stg_orders', type: 'model', distance: 1 }],
			downstream: [],
			stats: { upstream_count: 1, downstream_count: 0, total_dependencies: 1 },
		})),
		findModelsByName: vi.fn((name: string) =>
			name === 'customers' ? [{ uniqueId: 'model.p.customers', name: 'customers' }] : [],
		),
		findResource: vi.fn((name: string) => {
			const uid = name === 'stg_orders' ? 'model.p.stg_orders' : name === 'customers' ? 'model.p.customers' : undefined;
			return uid ? [{ uniqueId: uid, name, type: 'model' }] : [];
		}),
		getColumns: vi.fn(() => undefined),
		setColumns: vi.fn(),
	} as unknown as ManifestIndexer;
}

function makeTool(): GetColumnLineageTool {
	const parser = new SqllensDocumentParser({ adapterType: 'databricks' });
	return new GetColumnLineageTool(makeIndexer(), logger, compileCache, describeCache, parser);
}

describe('GetColumnLineageTool — real SqllensDocumentParser on a raw jinja model', () => {
	it('resolves a column through a `{{ ref() }}` table to the upstream model (the 0-deps regression guard)', async () => {
		const result = await makeTool().traceColumnDirect('model.p.customers', 'gold_orderkey', 'upstream');

		expect(result.error).toBeUndefined();
		// The bug: this array was EMPTY for every column. It must resolve to stg_orders.order_id.
		expect(result.dependencies.length).toBeGreaterThan(0);
		expect(result.dependencies.some(d => d.column === 'order_id')).toBe(true);
		// And the ref target must resolve to the real dbt model, not a placeholder.
		expect(result.dependencies.some(d => d.dbt_resource === 'model.p.stg_orders')).toBe(true);
	});

	it('traces a second column of the same jinja model independently', async () => {
		const result = await makeTool().traceColumnDirect('model.p.customers', 'amount', 'upstream');
		expect(result.error).toBeUndefined();
		expect(result.dependencies.some(d => d.column === 'amount')).toBe(true);
	});
});
