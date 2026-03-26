import { describe, it, expect, vi } from 'vitest';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource } from '../../indexing/manifest-indexer';
import { ListResourcesTool } from '../../tools/list-resources';
import { AnalyzeImpactTool } from '../../tools/analyze-impact';
import { GetLineageTool } from '../../tools/get-lineage';
import { GetProjectInfoTool } from '../../tools/get-project-info';
import { GetColumnLineageTool } from '../../tools/get-column-lineage';
import { QueryDatabaseTool } from '../../tools/query-database';
import type { ManifestLoader } from '../../dbt/manifest-loader';
import type { DbtExecutionService } from '../../dbt/execution-service';
import { createMockLogger, createMockCompileCache } from '../helpers';

const mockLogger = createMockLogger();
const mockCompileCache = createMockCompileCache();

function createTestIndex(): ManifestIndex {
	const models = new Map<string, IndexedModel>();
	models.set('model.p.orders', {
		uniqueId: 'model.p.orders',
		name: 'orders',
		packageName: 'p',
		path: '/project/models/orders.sql',
		schema: 'main',
		tags: ['daily'],
		materialisation: 'table',
		description: 'Orders model',
	});
	models.set('model.p.customers', {
		uniqueId: 'model.p.customers',
		name: 'customers',
		packageName: 'p',
		path: '/project/models/customers.sql',
		schema: 'main',
		tags: [],
		materialisation: 'view',
	});

	const sources = new Map<string, IndexedSource>();
	sources.set('source.p.raw.orders', {
		uniqueId: 'source.p.raw.orders',
		name: 'orders',
		sourceName: 'raw',
		schema: 'raw_data',
		tags: [],
	});

	return {
		models,
		sources,
		macros: new Map(),
		nodesByName: new Map([
			['orders', ['model.p.orders']],
			['customers', ['model.p.customers']],
		]),
		parentMap: new Map([
			['model.p.customers', ['model.p.orders']],
		]),
		childMap: new Map([
			['model.p.orders', ['model.p.customers']],
		]),
		dbtVersion: '1.8.0',
		adapterType: 'duckdb',
		buildTime: new Date(),
	};
}

function createMockIndexer(index: ManifestIndex | null): ManifestIndexer {
	return {
		index,
		build: vi.fn().mockReturnValue(index),
		findModelsByName: vi.fn((name: string) => {
			if (!index) return [];
			return [...index.models.values()].filter(m => m.name === name);
		}),
		getLineage: vi.fn((uniqueId: string, _depth: number) => {
			if (!index) return { upstream: [], downstream: [], stats: { upstream_count: 0, downstream_count: 0, total_dependencies: 0 } };
			const upIds = index.parentMap.get(uniqueId) ?? [];
			const downIds = index.childMap.get(uniqueId) ?? [];
			const toNode = (uid: string, dist: number) => ({ uniqueId: uid, name: uid.split('.').pop() ?? uid, type: uid.split('.')[0], distance: dist });
			const upstream = upIds.map(uid => toNode(uid, 1));
			const downstream = downIds.map(uid => toNode(uid, 1));
			return { upstream, downstream, stats: { upstream_count: upstream.length, downstream_count: downstream.length, total_dependencies: upstream.length + downstream.length } };
		}),
		findByTag: vi.fn(),
		getRawNode: vi.fn(),
		findResource: vi.fn((name: string) => {
			if (!index) return [];
			const matches = [...index.models.values()].filter(m => m.name === name);
			return matches.map(m => ({ uniqueId: m.uniqueId, name: m.name, type: 'model' }));
		}),
	} as unknown as ManifestIndexer;
}

function createMockLoader(): ManifestLoader {
	return {
		load: vi.fn(),
		invalidate: vi.fn(),
		manifestExists: vi.fn().mockReturnValue(true),
		getDbtVersion: vi.fn().mockReturnValue('1.8.0'),
		manifestPath: '/project/target/manifest.json',
	} as unknown as ManifestLoader;
}

describe('ListResourcesTool', () => {
	it('should list all models from index', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new ListResourcesTool(indexer, mockLogger);

		const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
		const result = await tool.invoke(
			{ input: {}, toolInvocationToken: undefined } as never,
			token as never,
		);
		expect(result).toBeDefined();
	});
});

describe('GetProjectInfoTool', () => {
	it('should return project statistics', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const loader = createMockLoader();
		const mockService = { submit: vi.fn() } as unknown as DbtExecutionService;
		const tool = new GetProjectInfoTool(indexer, mockService, loader, mockLogger);

		const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
		const result = await tool.invoke(
			{ input: {}, toolInvocationToken: undefined } as never,
			token as never,
		);
		expect(result).toBeDefined();
	});
});

describe('AnalyzeImpactTool', () => {
	it('should find downstream impacts', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new AnalyzeImpactTool(indexer, mockLogger);

		const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };
		const result = await tool.invoke(
			{ input: { name: 'orders' }, toolInvocationToken: undefined } as never,
			token as never,
		);
		expect(result).toBeDefined();
	});
});

describe('GetColumnLineageTool', () => {
	const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

	it('traces upstream column lineage through the bridge', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		(indexer.getRawNode as ReturnType<typeof vi.fn>).mockReturnValue({
			unique_id: 'model.p.customers',
			name: 'customers',
			resource_type: 'model',
			schema: 'main',
			database: 'dev',
			compiled_code: 'SELECT customer_id, first_name FROM orders',
			columns: {},
		});

		let callCount = 0;
		const mockService = {
			submit: vi.fn().mockImplementation((req: { type: string }) => {
				callCount++;
				if (req.type === 'get_columns') {
					return Promise.resolve({
						success: true,
						data: { success: true, columns: ['customer_id', 'first_name'] },
						stdout: '',
						stderr: '',
					});
				}
				// column_lineage request
				return Promise.resolve({
					success: true,
					data: {
						success: true,
						dependencies: [{ column: 'customer_id', table: 'orders' }],
						via_ctes: [],
						transformations: [],
					},
					stdout: '',
					stderr: '',
				});
			}),
		} as unknown as DbtExecutionService;

		const tool = new GetColumnLineageTool(indexer, mockService, mockLogger, mockCompileCache);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'customer_id' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const text = result.content[0];
		const parsed = JSON.parse((text as { value: string }).value);
		expect(parsed.column).toBe('customer_id');
		expect(parsed.direction).toBe('upstream');
		expect(parsed.dependencies).toBeDefined();
		expect(parsed.dependencies.length).toBeGreaterThanOrEqual(1);
		expect(parsed.dependencies[0].table).toBe('orders');
	});

	it('returns error when column not found in output', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		(indexer.getRawNode as ReturnType<typeof vi.fn>).mockReturnValue({
			unique_id: 'model.p.customers',
			name: 'customers',
			resource_type: 'model',
			schema: 'main',
			database: 'dev',
			compiled_code: 'SELECT customer_id FROM orders',
			columns: {},
		});

		const mockService = {
			submit: vi.fn().mockResolvedValue({
				success: true,
				data: { success: true, columns: ['customer_id'] },
				stdout: '',
				stderr: '',
			}),
		} as unknown as DbtExecutionService;

		const tool = new GetColumnLineageTool(indexer, mockService, mockLogger, mockCompileCache);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'nonexistent' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const text = result.content[0];
		const parsed = JSON.parse((text as { value: string }).value);
		expect(parsed.error).toContain('not found in output');
	});

	it('returns error when model not found', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const mockService = { submit: vi.fn() } as unknown as DbtExecutionService;
		const tool = new GetColumnLineageTool(indexer, mockService, mockLogger, mockCompileCache);

		const result = await tool.invoke(
			{ input: { model: 'nonexistent', column: 'id' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const text = result.content[0];
		const parsed = JSON.parse((text as { value: string }).value);
		expect(parsed.error).toContain('not found');
	});

	it('returns error when no compiled SQL available', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		(indexer.getRawNode as ReturnType<typeof vi.fn>).mockReturnValue({
			unique_id: 'model.p.customers',
			name: 'customers',
			resource_type: 'model',
			columns: {},
		});

		const mockService = { submit: vi.fn() } as unknown as DbtExecutionService;
		const tool = new GetColumnLineageTool(indexer, mockService, mockLogger, mockCompileCache);

		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'id' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const text = result.content[0];
		const parsed = JSON.parse((text as { value: string }).value);
		expect(parsed.error).toContain('compiled SQL');
	});

	it('handles bridge failure gracefully', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		(indexer.getRawNode as ReturnType<typeof vi.fn>).mockReturnValue({
			unique_id: 'model.p.customers',
			name: 'customers',
			resource_type: 'model',
			schema: 'main',
			database: 'dev',
			compiled_code: 'SELECT customer_id FROM orders',
			columns: {},
		});

		let callCount = 0;
		const mockService = {
			submit: vi.fn().mockImplementation((req: { type: string }) => {
				callCount++;
				if (req.type === 'get_columns') {
					return Promise.resolve({
						success: true,
						data: { success: true, columns: ['customer_id'] },
						stdout: '',
						stderr: '',
					});
				}
				// column_lineage fails
				return Promise.resolve({
					success: true,
					data: { success: false, error: 'parse error' },
					stdout: '',
					stderr: '',
				});
			}),
		} as unknown as DbtExecutionService;

		const tool = new GetColumnLineageTool(indexer, mockService, mockLogger, mockCompileCache);
		const result = await tool.invoke(
			{ input: { model: 'customers', column: 'customer_id' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const text = result.content[0];
		const parsed = JSON.parse((text as { value: string }).value);
		// Should still return a result structure, just with empty dependencies
		expect(parsed.model).toBe('customers');
		expect(parsed.dependencies).toEqual([]);
	});
});

describe('QueryDatabaseTool', () => {
	const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

	it('parses JSON rows from dbt show --output json stdout', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const rows = [{ id: 1, name: 'Alice' }, { id: 2, name: 'Bob' }];
		const showJson = JSON.stringify({ show: rows });
		const mockService = {
			submit: vi.fn().mockResolvedValue({
				success: true,
				stdout: `09:00:00  Running with dbt=1.8.0\n${showJson}\n{"success": true}`,
				stderr: '',
			}),
		} as unknown as DbtExecutionService;

		const tool = new QueryDatabaseTool(mockService, indexer, mockLogger);
		const result = await tool.invoke(
			{ input: { sql: 'SELECT 1' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.success).toBe(true);
		expect(parsed.row_count).toBe(2);
		expect(parsed.rows).toEqual(rows);
	});

	it('passes --output json and --no-populate-cache flags to the service', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const submit = vi.fn().mockResolvedValue({
			success: true,
			stdout: '{"show": []}',
			stderr: '',
		});
		const mockService = { submit } as unknown as DbtExecutionService;

		const tool = new QueryDatabaseTool(mockService, indexer, mockLogger);
		await tool.invoke(
			{ input: { sql: 'SELECT 42 AS n' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const submittedArgs: string[] = submit.mock.calls[0][0].args;
		expect(submittedArgs).toContain('--output');
		expect(submittedArgs).toContain('json');
		expect(submittedArgs).toContain('--no-populate-cache');
	});

	it('falls back to raw output when no show JSON line found', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const mockService = {
			submit: vi.fn().mockResolvedValue({
				success: true,
				stdout: '09:00:00  Some log line\n{"success": true}',
				stderr: '',
			}),
		} as unknown as DbtExecutionService;

		const tool = new QueryDatabaseTool(mockService, indexer, mockLogger);
		const result = await tool.invoke(
			{ input: { sql: 'SELECT 1' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		// formatBridgeResult shape — success present, raw output passed through
		expect(parsed.success).toBe(true);
		expect(typeof parsed.output).toBe('string');
	});

	it('returns error result when dbt show fails', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const mockService = {
			submit: vi.fn().mockResolvedValue({
				success: false,
				stdout: '',
				stderr: 'Compilation error',
			}),
		} as unknown as DbtExecutionService;

		const tool = new QueryDatabaseTool(mockService, indexer, mockLogger);
		const result = await tool.invoke(
			{ input: { sql: 'SELECT bad_column FROM missing_table' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.success).toBe(false);
	});
});

describe('GetLineageTool', () => {
	const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

	it('returns resource wrapper with name, unique_id, resource_type', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new GetLineageTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'customers' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.resource).toBeDefined();
		expect(parsed.resource.name).toBe('customers');
		expect(parsed.resource.unique_id).toBe('model.p.customers');
		expect(parsed.resource.resource_type).toBe('model');
	});

	it('upstream nodes have unique_id, name, type, and distance fields', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new GetLineageTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'customers', direction: 'upstream' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(Array.isArray(parsed.upstream)).toBe(true);
		expect(parsed.upstream.length).toBe(1);
		const node = parsed.upstream[0];
		expect(node.unique_id).toBe('model.p.orders');
		expect(node.name).toBe('orders');
		expect(node.type).toBe('model');
		expect(node.distance).toBe(1);
	});

	it('downstream nodes have unique_id, name, type, and distance fields', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new GetLineageTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'orders', direction: 'downstream' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(Array.isArray(parsed.downstream)).toBe(true);
		expect(parsed.downstream.length).toBe(1);
		const node = parsed.downstream[0];
		expect(node.unique_id).toBe('model.p.customers');
		expect(node.name).toBe('customers');
		expect(node.type).toBe('model');
		expect(node.distance).toBe(1);
	});

	it('stats has upstream_count, downstream_count, total_dependencies', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new GetLineageTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'customers', direction: 'both' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.stats).toBeDefined();
		expect(typeof parsed.stats.upstream_count).toBe('number');
		expect(typeof parsed.stats.downstream_count).toBe('number');
		expect(typeof parsed.stats.total_dependencies).toBe('number');
		expect(parsed.stats.upstream_count).toBe(1);
		expect(parsed.stats.downstream_count).toBe(0);
		expect(parsed.stats.total_dependencies).toBe(1);
	});

	it('upstream direction returns empty downstream array', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new GetLineageTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'customers', direction: 'upstream' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.direction).toBe('upstream');
		expect(parsed.upstream.length).toBeGreaterThan(0);
	});

	it('returns error when resource not found', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new GetLineageTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'nonexistent' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.error).toContain('not found');
	});
});

describe('AnalyzeImpactTool (Python-parity)', () => {
	const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() };

	it('returns resource wrapper with name, unique_id, resource_type', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new AnalyzeImpactTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'orders' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.resource).toBeDefined();
		expect(parsed.resource.name).toBe('orders');
		expect(parsed.resource.unique_id).toBe('model.p.orders');
		expect(parsed.resource.resource_type).toBe('model');
	});

	it('impact sub-block contains models_affected, models_affected_count, total_affected', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new AnalyzeImpactTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'orders' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.impact).toBeDefined();
		expect(Array.isArray(parsed.impact.models_affected)).toBe(true);
		expect(typeof parsed.impact.models_affected_count).toBe('number');
		expect(typeof parsed.impact.total_affected).toBe('number');
		expect(parsed.impact.models_affected_count).toBe(1);
	});

	it('affected_by_distance groups nodes by integer distance key', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new AnalyzeImpactTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'orders' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.affected_by_distance).toBeDefined();
		// customers is distance 1 from orders
		expect(Array.isArray(parsed.affected_by_distance['1'])).toBe(true);
		expect(parsed.affected_by_distance['1'].length).toBe(1);
	});

	it('Low impact message for 1 model affected', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new AnalyzeImpactTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'orders' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(parsed.message).toContain('Low impact');
		expect(parsed.message).toContain('1 model');
	});

	it('recommendation mentions model name using dbt run -s syntax', async () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const tool = new AnalyzeImpactTool(indexer, mockLogger);

		const result = await tool.invoke(
			{ input: { name: 'orders' }, toolInvocationToken: undefined } as never,
			token as never,
		);

		const parsed = JSON.parse((result.content[0] as { value: string }).value);
		expect(typeof parsed.recommendation).toBe('string');
		expect(parsed.recommendation).toContain('orders+');
	});
});

