import { describe, it, expect, vi } from 'vitest';
import { YamlCompletionProvider } from '../../../providers/yaml/completion-provider';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedFunction } from '../../../indexing/manifest-indexer';
import { createMockLogger } from '../../helpers';

const mockLogger = createMockLogger();

function createMockIndexer(index: ManifestIndex): ManifestIndexer {
	return { index } as unknown as ManifestIndexer;
}

function createTestIndex(): ManifestIndex {
	const models = new Map<string, IndexedModel>();
	models.set('model.p.orders', {
		uniqueId: 'model.p.orders',
		name: 'orders',
		packageName: 'p',
		path: '/project/models/orders.sql',
		tags: [],
		materialisation: 'table',
	});

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

	return {
		models,
		sources: new Map(),
		macros: new Map(),
		functions,
		nodesByName: new Map(),
		parentMap: new Map(),
		childMap: new Map(),
		dbtVersion: '1.12.0',
		adapterType: 'databricks',
		buildTime: new Date(),
	};
}

function mockDocument(lines: string[]) {
	return {
		lineAt: (line: number) => ({ text: lines[line] ?? '' }),
	} as unknown as import('vscode').TextDocument;
}

describe('YamlCompletionProvider — functions block', () => {
	it('completes function names for "- name:" inside a functions: block', () => {
		const provider = new YamlCompletionProvider(createMockIndexer(createTestIndex()), mockLogger);
		const lines = [
			'functions:',
			'  - name: ',
		];
		const items = provider.provideCompletionItems(
			mockDocument(lines),
			{ line: 1, character: lines[1].length } as import('vscode').Position,
		);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('days_since');
		expect(labels).not.toContain('orders');
	});

	it('a functions: block does not leak into models-block detection above it', () => {
		const provider = new YamlCompletionProvider(createMockIndexer(createTestIndex()), mockLogger);
		// "models:" appears above, but "functions:" intervenes before the cursor's
		// "- name:" line — the cursor must resolve to function names, not model names.
		const lines = [
			'models:',
			'  - name: orders',
			'functions:',
			'  - name: ',
		];
		const items = provider.provideCompletionItems(
			mockDocument(lines),
			{ line: 3, character: lines[3].length } as import('vscode').Position,
		);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('days_since');
		expect(labels).not.toContain('orders');
	});
});
