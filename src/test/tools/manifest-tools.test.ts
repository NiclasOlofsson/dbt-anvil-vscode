import { describe, it, expect, vi } from 'vitest';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource } from '../../indexing/manifest-indexer';
import { ListResourcesTool } from '../../tools/list-resources';
import { AnalyzeImpactTool } from '../../tools/analyze-impact';
import { GetProjectInfoTool } from '../../tools/get-project-info';
import type { ManifestLoader } from '../../dbt/manifest-loader';
import type { BridgeRunner } from '../../dbt/bridge-runner';
import { createMockLogger } from '../helpers';

const mockLogger = createMockLogger();

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
		getLineage: vi.fn((uniqueId: string, depth: number) => {
			if (!index) return { upstream: [], downstream: [] };
			const up = index.parentMap.get(uniqueId) ?? [];
			const down = index.childMap.get(uniqueId) ?? [];
			return { upstream: up, downstream: down };
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
		const mockBridge = { invoke: vi.fn(), invokeRaw: vi.fn() } as unknown as BridgeRunner;
		const tool = new GetProjectInfoTool(indexer, mockBridge, loader, mockLogger);

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
