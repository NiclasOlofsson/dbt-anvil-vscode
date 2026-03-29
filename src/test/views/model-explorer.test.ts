import { describe, it, expect, vi } from 'vitest';
import { ModelExplorerProvider } from '../../views/model-explorer-provider';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource } from '../../indexing/manifest-indexer';
import { createMockLogger } from '../helpers';
import type * as vscode from 'vscode';

const mockGlobalState: vscode.Memento = {
	get: vi.fn().mockReturnValue(false),
	update: vi.fn().mockResolvedValue(undefined),
	keys: vi.fn().mockReturnValue([]),
} as unknown as vscode.Memento;

const mockLogger = createMockLogger();

function createMockIndexer(index: ManifestIndex | null): ManifestIndexer {
	return {
		index,
		build: vi.fn(),
		findModelsByName: vi.fn(),
		getLineage: vi.fn(),
		findByTag: vi.fn(),
		getRawNode: vi.fn(),
	} as unknown as ManifestIndexer;
}

function createTestIndex(): ManifestIndex {
	const models = new Map<string, IndexedModel>();
	models.set('model.p.orders', {
		uniqueId: 'model.p.orders',
		name: 'orders',
		packageName: 'p',
		path: '/project/models/orders.sql',
		schema: 'main',
		tags: [],
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
		description: 'Customers model',
	});

	const sources = new Map<string, IndexedSource>();
	sources.set('source.p.raw.orders', {
		uniqueId: 'source.p.raw.orders',
		name: 'orders',
		sourceName: 'raw',
		schema: 'raw_data',
		tags: [],
		description: 'Raw orders',
	});

	return {
		models,
		sources,
		macros: new Map(),
		nodesByName: new Map(),
		parentMap: new Map(),
		childMap: new Map(),
		dbtVersion: '1.8.0',
		adapterType: 'ansi',
		buildTime: new Date(),
	};
}

describe('ModelExplorerProvider', () => {
	it('should return empty array when no index exists', () => {
		const indexer = createMockIndexer(null);
		const provider = new ModelExplorerProvider(indexer, mockLogger, '/project', mockGlobalState);
		const children = provider.getChildren();
		expect(children).toHaveLength(0);
	});

	it('should show model groups when index exists', () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const provider = new ModelExplorerProvider(indexer, mockLogger, '/project', mockGlobalState);
		const root = provider.getChildren();

		// Should have Models and Sources groups
		expect(root.length).toBeGreaterThanOrEqual(2);
	});

	it('should fire onDidChangeTreeData on refresh', () => {
		const indexer = createMockIndexer(null);
		const provider = new ModelExplorerProvider(indexer, mockLogger, '/project', mockGlobalState);
		const listener = vi.fn();
		provider.onDidChangeTreeData(listener);
		provider.refresh();
		expect(listener).toHaveBeenCalled();
	});
});
