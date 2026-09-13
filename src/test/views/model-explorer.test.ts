import { describe, it, expect, vi } from 'vitest';
import { ModelExplorerProvider, GroupItem, FunctionItem } from '../../views/model-explorer-provider';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource, IndexedFunction } from '../../indexing/manifest-indexer';
import { createMockLogger } from '../helpers';
import * as vscode from 'vscode';

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

function createTestIndex(functions = new Map<string, IndexedFunction>()): ManifestIndex {
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
		functions,
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

	it('should show a Functions (1) root group holding the function, opening its file', () => {
		const functions = new Map<string, IndexedFunction>();
		functions.set('function.p.days_since', {
			uniqueId: 'function.p.days_since',
			name: 'days_since',
			packageName: 'p',
			path: '/project/functions/days_since.sql',
			tags: [],
			arguments: [{ name: 'date', dataType: 'date' }],
			returns: 'integer',
			functionType: 'scalar',
		});
		const index = createTestIndex(functions);
		const indexer = createMockIndexer(index);
		const provider = new ModelExplorerProvider(indexer, mockLogger, '/project', mockGlobalState);
		const root = provider.getChildren();

		const functionsGroup = root.find(item => item instanceof GroupItem && item.label === 'Functions (1)') as GroupItem;
		expect(functionsGroup).toBeDefined();
		expect(functionsGroup.children).toHaveLength(1);

		const fnItem = functionsGroup.children[0] as FunctionItem;
		expect(fnItem).toBeInstanceOf(FunctionItem);
		expect(fnItem.fn.name).toBe('days_since');
		expect(fnItem.command?.command).toBe('vscode.open');
		expect((fnItem.command?.arguments?.[0] as vscode.Uri).fsPath).toBe(
			vscode.Uri.file('/project/functions/days_since.sql').fsPath,
		);
	});

	it('should show no Functions group when the index has no functions', () => {
		const index = createTestIndex();
		const indexer = createMockIndexer(index);
		const provider = new ModelExplorerProvider(indexer, mockLogger, '/project', mockGlobalState);
		const root = provider.getChildren();

		expect(root.find(item => item instanceof GroupItem && item.label?.toString().startsWith('Functions'))).toBeUndefined();
	});
});
