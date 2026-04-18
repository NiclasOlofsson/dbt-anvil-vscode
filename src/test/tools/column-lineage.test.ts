/**
 * Unit tests for get-column-lineage.ts
 *
 * Covers:
 * - mapAdapterToDialect adapter name normalisation
 * - GetColumnLineageTool invoke() response shape (new namespaced transformation format)
 * - via_ctes derived from cte-type transformations
 * - downstream response shape (returns usages array)
 * - column-not-found error message format
 * - dependency_count present in upstream response
 */
import { describe, it, expect, vi } from 'vitest';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource } from '../../indexing/manifest-indexer';
import { mapAdapterToDialect } from '../../ftl/ftl-document-parser';
import { GetColumnLineageTool } from '../../tools/get-column-lineage';
import type { FtlDocumentParser } from '../../ftl/ftl-document-parser';
import { createMockLogger, createMockCompileCache } from '../helpers';

vi.mock('fs', () => ({
	default: { readFileSync: vi.fn().mockReturnValue('SELECT customer_id, first_name FROM orders') },
	readFileSync: vi.fn().mockReturnValue('SELECT customer_id, first_name FROM orders'),
}));

const mockLogger = createMockLogger();
// The mock raw node has this compiled_code — the mock compile cache returns it so traceColumnDirect works
const DEFAULT_COMPILED_SQL = 'SELECT customer_id, first_name FROM orders';
const mockCompileCache = createMockCompileCache(DEFAULT_COMPILED_SQL);
const mockDescribeCache = { columns: vi.fn().mockResolvedValue(undefined) } as never;
const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestIndex(): ManifestIndex {
	const models = new Map<string, IndexedModel>();
	models.set('model.p.customers', {
		uniqueId: 'model.p.customers',
		name: 'customers',
		packageName: 'p',
		path: '/project/models/customers.sql',
		schema: 'main',
		tags: [],
		materialisation: 'table',
	});
	models.set('model.p.orders', {
		uniqueId: 'model.p.orders',
		name: 'orders',
		packageName: 'p',
		path: '/project/models/orders.sql',
		schema: 'main',
		tags: [],
		materialisation: 'table',
	});

	const sources = new Map<string, IndexedSource>();

	return {
		models,
		sources,
		macros: new Map(),
		nodesByName: new Map([
			['customers', ['model.p.customers']],
			['orders', ['model.p.orders']],
		]),
		parentMap: new Map([['model.p.customers', ['model.p.orders']]]),
		childMap: new Map([['model.p.orders', ['model.p.customers']]]),
		dbtVersion: '1.8.0',
		adapterType: 'databricks',
		buildTime: new Date(),
	};
}

function createMockIndexer(index: ManifestIndex, rawNode?: Record<string, unknown>, rawNodesByUid?: Record<string, Record<string, unknown>>): ManifestIndexer {
	const columnStore = new Map<string, string[]>();
	return {
		index,
		build: vi.fn(),
		findModelsByName: vi.fn((name: string) =>
			[...index.models.values()].filter(m => m.name === name),
		),
		getLineage: vi.fn((uniqueId: string) => {
			const upIds = index.parentMap.get(uniqueId) ?? [];
			const downIds = index.childMap.get(uniqueId) ?? [];
			const toNode = (uid: string, dist: number) => ({
				uniqueId: uid,
				name: uid.split('.').pop() ?? uid,
				type: uid.split('.')[0],
				distance: dist,
			});
			const upstream = upIds.map(uid => toNode(uid, 1));
			const downstream = downIds.map(uid => toNode(uid, 1));
			return {
				upstream,
				downstream,
				stats: {
					upstream_count: upstream.length,
					downstream_count: downstream.length,
					total_dependencies: upstream.length + downstream.length,
				},
			};
		}),
		findByTag: vi.fn(),
		projectDir: '/project',
		getRawNode: vi.fn((uniqueId: string) => rawNodesByUid?.[uniqueId] ?? rawNode ?? {
			unique_id: 'model.p.customers',
			name: 'customers',
			resource_type: 'model',
			schema: 'main',
			database: 'dev',
			original_file_path: 'models/customers.sql',
			raw_code: 'SELECT customer_id, first_name FROM {{ ref(\'orders\') }}',
			compiled_code: 'SELECT customer_id, first_name FROM orders',
			columns: {},
		}),
		findResource: vi.fn((name: string) =>
			[...index.models.values()]
				.filter(m => m.name === name)
				.map(m => ({ uniqueId: m.uniqueId, name: m.name, type: 'model' })),
		),
		getColumns: vi.fn((uniqueId: string) => columnStore.get(uniqueId)),
		setColumns: vi.fn((uniqueId: string, columns: string[]) => {
			columnStore.set(uniqueId, columns);
		}),
		adapterType: index.adapterType,
	} as unknown as ManifestIndexer;
}

function makeFtlParser(colsResponse: string[], lineageData?: Record<string, unknown>): FtlDocumentParser {
	return {
		parse: vi.fn().mockResolvedValue({
			finalColumns: colsResponse.map(name => ({ name, line: 0 })),
			ctes: [],
			refs: [],
			sources: [],
			finalSelect: undefined,
			tokens: [],
			timing: { parseMs: 0, totalMs: 0 },
		}),
		traceLineageV2: vi.fn().mockResolvedValue(lineageData ?? {
			dependencies: [],
			via_ctes: [],
			transformations: [],
		}),
	} as unknown as FtlDocumentParser;
}

// ---------------------------------------------------------------------------
// mapAdapterToDialect
// ---------------------------------------------------------------------------

describe('mapAdapterToDialect', () => {
	it('maps databricks to databricks', () => {
		expect(mapAdapterToDialect('databricks')).toBe('databricks');
	});

	it('maps postgres to postgres', () => {
		expect(mapAdapterToDialect('postgres')).toBe('postgres');
	});

	it('maps postgresql to postgres (alias)', () => {
		expect(mapAdapterToDialect('postgresql')).toBe('postgres');
	});

	it('maps synapse to tsql', () => {
		expect(mapAdapterToDialect('synapse')).toBe('tsql');
	});

	it('maps sqlserver to tsql', () => {
		expect(mapAdapterToDialect('sqlserver')).toBe('tsql');
	});

	it('maps fabricspark to spark', () => {
		expect(mapAdapterToDialect('fabricspark')).toBe('spark');
	});

	it('maps glue to spark', () => {
		expect(mapAdapterToDialect('glue')).toBe('spark');
	});

	it('maps bigquery to bigquery', () => {
		expect(mapAdapterToDialect('bigquery')).toBe('bigquery');
	});

	it('passes through unknown adapter lowercased', () => {
		expect(mapAdapterToDialect('MyUnknownDb')).toBe('myunknowndb');
	});
});

// ---------------------------------------------------------------------------
// GetColumnLineageTool — upstream response shape
// ---------------------------------------------------------------------------

describe('GetColumnLineageTool upstream response shape', () => {
	it('returns model, column, direction, dependencies, dependency_count', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const ftlParser = makeFtlParser(['customer_id', 'first_name'], {
			dependencies: [{ column: 'customer_id', table: 'orders' }],
			via_ctes: [],
			transformations: [],
		});

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'customer_id', direction: 'upstream' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.model).toBe('customers');
		expect(parsed.column).toBe('customer_id');
		expect(parsed.direction).toBe('upstream');
		expect(Array.isArray(parsed.dependencies)).toBe(true);
		expect(typeof parsed.dependency_count).toBe('number');
	});

	it('transformations and via_ctes fields are present in upstream response', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const ftlParser = makeFtlParser(['customer_id']);

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'customer_id' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(Array.isArray(parsed.transformations)).toBe(true);
		expect(Array.isArray(parsed.via_ctes)).toBe(true);
	});

	it('via_ctes is extracted from cte-type transformations with namespaced ids', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const lineageData = {
			dependencies: [],
			via_ctes: [],
			transformations: [
				{ id: 'query', type: 'outer_query', column: 'customer_id', sources: ['cte:final'] },
				{ id: 'cte:final', type: 'cte', column: 'customer_id', expression: 'customer_id', sources: ['cte:base'] },
				{ id: 'cte:base', type: 'cte', column: 'customer_id', expression: 'customer_id', sources: [] },
			],
		};
		const ftlParser = makeFtlParser(['customer_id'], lineageData);

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'customer_id' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.via_ctes).toContain('final');
		expect(parsed.via_ctes).toContain('base');
	});

	it('dependency_count equals length of dependencies array', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const ftlParser = makeFtlParser(['customer_id', 'first_name'], {
			dependencies: [
				{ column: 'customer_id', table: 'orders' },
				{ column: 'customer_id', table: 'stg_customers', schema: 'staging' },
			],
			via_ctes: [],
			transformations: [],
		});

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'customer_id' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.dependency_count).toBe(parsed.dependencies.length);
	});
});

// ---------------------------------------------------------------------------
// GetColumnLineageTool — downstream response shape
// ---------------------------------------------------------------------------

describe('GetColumnLineageTool downstream response shape', () => {
	it('direction=downstream returns usages array instead of dependencies', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const ftlParser = makeFtlParser(['customer_id']);

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'customer_id', direction: 'downstream' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.direction).toBe('downstream');
		expect(Array.isArray(parsed.usages)).toBe(true);
		// dependencies should not be present for downstream
		expect(parsed.dependencies).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// GetColumnLineageTool — error paths
// ---------------------------------------------------------------------------

describe('GetColumnLineageTool error paths', () => {
	it('error message includes model name when column not found in output', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		// Returns only 'customer_id', not 'unknown_col'
		const ftlParser = makeFtlParser(['customer_id']);

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'unknown_col' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.error).toContain('customers');
		expect(parsed.error).toContain('unknown_col');
	});

	it('error message lists available columns when column not found', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const ftlParser = makeFtlParser(['customer_id', 'first_name']);

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'missing' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.error).toMatch(/customer_id|first_name/);
	});
});

describe('GetColumnLineageTool relation disambiguation', () => {
	it('prefers model when ambiguous bare table matches both direct model and source parents', async () => {
		const models = new Map<string, IndexedModel>([
			['model.p.customers', {
				uniqueId: 'model.p.customers',
				name: 'customers',
				packageName: 'p',
				path: '/project/models/customers.sql',
				schema: 'norm',
				tags: [],
				materialisation: 'view',
			}],
			['model.p.transfer', {
				uniqueId: 'model.p.transfer',
				name: 'transfer',
				packageName: 'p',
				path: '/project/models/transfer.sql',
				schema: 'norm',
				tags: [],
				materialisation: 'view',
			}],
		]);

		const sources = new Map<string, IndexedSource>([
			['source.p.raw.transfer', {
				uniqueId: 'source.p.raw.transfer',
				name: 'transfer',
				sourceName: 'raw',
				schema: 'raw',
				database: 'dev',
				tags: [],
			}],
		]);

		const index: ManifestIndex = {
			models,
			sources,
			macros: new Map(),
			nodesByName: new Map([
				['customers', ['model.p.customers']],
				['transfer', ['model.p.transfer']],
				['raw.transfer', ['source.p.raw.transfer']],
			]),
			parentMap: new Map([
				['model.p.customers', ['model.p.transfer', 'source.p.raw.transfer']],
			]),
			childMap: new Map(),
			dbtVersion: '1.8.0',
			adapterType: 'databricks',
			buildTime: new Date(),
		};

		const rawNodesByUid: Record<string, Record<string, unknown>> = {
			'model.p.customers': {
				unique_id: 'model.p.customers',
				name: 'customers',
				resource_type: 'model',
				schema: 'norm',
				database: 'dev',
				original_file_path: 'models/customers.sql',
				columns: {},
			},
			'model.p.transfer': {
				unique_id: 'model.p.transfer',
				name: 'transfer',
				resource_type: 'model',
				schema: 'norm',
				database: 'dev',
				alias: 'transfer',
				original_file_path: 'models/transfer.sql',
				columns: { transferid: { data_type: 'int' } },
			},
			'source.p.raw.transfer': {
				unique_id: 'source.p.raw.transfer',
				name: 'transfer',
				resource_type: 'source',
				source_name: 'raw',
				identifier: 'transfer',
				schema: 'raw',
				database: 'dev',
				columns: { transferid: { data_type: 'int' } },
			},
		};

		const indexer = createMockIndexer(index, undefined, rawNodesByUid);
		const ftlParser = makeFtlParser(['transferid'], {
			dependencies: [{ table: 'transfer', column: 'transferid' }],
			via_ctes: [],
			transformations: [],
		});

		const tool = new GetColumnLineageTool(indexer, mockLogger, mockCompileCache, mockDescribeCache, ftlParser);
		const result = await tool.traceColumnDirect('model.p.customers', 'transferid', 'upstream');

		expect(result.error).toBeUndefined();
		expect(result.dependencies.some(d => d.dbt_resource === 'model.p.transfer')).toBe(true);
		expect(result.dependencies.some(d => d.dbt_resource === 'source.p.raw.transfer')).toBe(false);
	});
});

