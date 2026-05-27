import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ParseService } from '../services/parse-service';
import type { DocumentModel } from '../services/parse-service';

import { DbtCompletionProvider } from '../providers/sql/completion-provider';
import { createMockLogger } from './helpers';

// ─── helpers ─────────────────────────────────────────────────────────────────

function mockDocument(lines: string[], version = 1) {
	const text = lines.join('\n');
	return {
		getText: () => text,
		lineAt: (line: number) => ({ text: lines[line] ?? '' }),
		offsetAt: ({ line, character }: { line: number; character: number }) => {
			let offset = 0;
			for (let i = 0; i < line; i++) offset += (lines[i]?.length ?? 0) + 1; // +1 for \n
			return offset + character;
		},
		uri: { toString: () => 'file:///test.sql' },
		version,
	};
}

function makeIndexer(): ManifestIndexer {
	return {
		index: { adapterType: 'duckdb', models: new Map(), sources: new Map() },
		findModelsByName: () => [],
		getRawNode: () => null,
		getColumns: () => null,
		setColumns: vi.fn(),
		buildSchemaMapping: () => ({}),
	} as unknown as ManifestIndexer;
}

function makeParseServiceWithAliases(aliases: Record<string, string[]>): ParseService {
	const model = {
		ctes: [],
		refs: [],
		sources: [],
		finalColumns: [],
		tokens: [],
		aliases,
		timing: { parseMs: 0, totalMs: 0 },
	} as unknown as DocumentModel;
	return {
		getDocumentModel: vi.fn().mockResolvedValue(model),
		evict: vi.fn(),
	} as unknown as ParseService;
}


const TOKEN = { isCancellationRequested: false };
const CTX = {};

// ─── tests ───────────────────────────────────────────────────────────────────

describe('DbtCompletionProvider — bare column completions', () => {
	let provider: DbtCompletionProvider;

	const aliases = {
		customers: ['id', 'name', 'email'],
		orders: ['id', 'order_date', 'amount'],
	};

	beforeEach(() => {
		provider = new DbtCompletionProvider(makeIndexer(), createMockLogger(), makeParseServiceWithAliases(aliases));
	});

	it('returns merged column list when typing a bare word in SELECT', async () => {
		const linePrefix = 'SELECT na';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		expect(items!.length).toBeGreaterThan(0);

		const labels = items!.map(i => i.label);
		expect(labels).toContain('name');
		expect(labels).toContain('id');
		expect(labels).toContain('order_date');
		expect(labels).toContain('email');
		expect(labels).toContain('amount');
	});

	it('deduplicates columns shared across tables with multi-table detail', async () => {
		const linePrefix = 'SELECT id';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		const idItem = items?.find(i => i.label === 'id');
		expect(idItem).toBeDefined();
		// Not "column of X" — should show both tables
		expect(idItem!.detail).not.toMatch(/^column of \w+$/);
		expect(idItem!.detail).toContain('customers');
		expect(idItem!.detail).toContain('orders');
	});

	it('shows single-table detail for column unique to one table', async () => {
		const linePrefix = 'SELECT em';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		const emailItem = items?.find(i => i.label === 'email');
		expect(emailItem).toBeDefined();
		expect(emailItem!.detail).toBe('column of customers');
	});

	it('returns table completions (not columns) after FROM keyword', async () => {
		const linePrefix = 'FROM cu';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		// Should return table/CTE completions (empty without ParseService), not column completions
		expect(items).toBeDefined();
		expect(items).toBeInstanceOf(Array);
		// No column items should leak through
		const columnItems = items?.filter(i => i.kind === 5 /* CompletionItemKind.Field */);
		expect(columnItems).toHaveLength(0);
	});

	it('returns table completions (not columns) after JOIN keyword', async () => {
		const linePrefix = 'JOIN ord';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		// Should return table/CTE completions (empty without ParseService), not column completions
		expect(items).toBeDefined();
		expect(items).toBeInstanceOf(Array);
		const columnItems = items?.filter(i => i.kind === 5 /* CompletionItemKind.Field */);
		expect(columnItems).toHaveLength(0);
	});

	it('returns [] (not undefined) when no aliases resolved', async () => {
		const p = new DbtCompletionProvider(makeIndexer(), createMockLogger(), makeParseServiceWithAliases({}));

		const linePrefix = 'SELECT na';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await p.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		// Empty alias map → _completeAllColumns returns [] early
		expect(items).toEqual([]);
	});
});

describe('DbtCompletionProvider — alias.column completions (existing)', () => {
	it('still works for alias. prefix', async () => {
		const aliases = { c: ['id', 'name'] };
		const provider = new DbtCompletionProvider(makeIndexer(), createMockLogger(), makeParseServiceWithAliases(aliases));

		const linePrefix = 'SELECT c.';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('id');
		expect(labels).toContain('name');
		expect(items![0].detail).toBe('column of c');
	});
});

describe('DbtCompletionProvider — FROM/JOIN with ParseService', () => {
	function makeParseService(model: DocumentModel): ParseService {
		return {
			getDocumentModel: vi.fn().mockResolvedValue(model),
			evict: vi.fn(),
		} as unknown as ParseService;
	}

	function makeIndexerWithModels(): ManifestIndexer {
		const models = new Map([
			['model.jaffle.customers', { name: 'customers', uniqueId: 'model.jaffle.customers', materialisation: 'table', packageName: 'jaffle', path: 'models/customers.sql', schema: 'main', tags: [], description: '' }],
			['model.jaffle.orders', { name: 'orders', uniqueId: 'model.jaffle.orders', materialisation: 'view', packageName: 'jaffle', path: 'models/orders.sql', schema: 'main', tags: [], description: '' }],
		]);
		return {
			index: { adapterType: 'duckdb', models, sources: new Map() },
			findModelsByName: () => [],
			getRawNode: () => null,
			getColumns: () => null,
			setColumns: vi.fn(),
			buildSchemaMapping: () => ({}),
		} as unknown as ManifestIndexer;
	}

	const docModel: DocumentModel = {
		ctes: [
			{ name: 'base', line: 0, endLine: 5, columns: [{ name: 'id', line: 1 }, { name: 'name', line: 2 }] },
			{ name: 'enriched', line: 6, endLine: 10, columns: [{ name: 'total', line: 7 }] },
		],
		refs: [],
		sources: [],
		finalColumns: [] as import('../services/parse-service').ColumnInfo[],
		tokens: [],
		timing: { parseMs: 1, totalMs: 2 },
	};

	it('returns CTE names before model names after FROM', async () => {
		const indexer = makeIndexerWithModels();
		const parseService = makeParseService(docModel);
		const provider = new DbtCompletionProvider(indexer, createMockLogger(), parseService);

		const linePrefix = 'FROM ';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('base');
		expect(labels).toContain('enriched');
		expect(labels).toContain('customers');
		expect(labels).toContain('orders');

		// CTEs should sort before models
		const baseIdx = items!.findIndex(i => i.label === 'base');
		const customersIdx = items!.findIndex(i => i.label === 'customers');
		expect(baseIdx).toBeLessThan(customersIdx);
	});

	it('shows CTE column count in detail', async () => {
		const parseService = makeParseService(docModel);
		const provider = new DbtCompletionProvider(makeIndexerWithModels(), createMockLogger(), parseService);

		const linePrefix = 'JOIN ';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		const baseItem = items!.find(i => i.label === 'base');
		expect(baseItem).toBeDefined();
		expect(baseItem!.detail).toBe('CTE (2 columns)');

		const enrichedItem = items!.find(i => i.label === 'enriched');
		expect(enrichedItem).toBeDefined();
		expect(enrichedItem!.detail).toBe('CTE (1 columns)');
	});
});

describe('DbtCompletionProvider — FQN completions', () => {
	function makeIndexerWithFqnModels(): ManifestIndexer {
		const models = new Map([
			['model.pkg.gold__company', {
				name: 'gold__company',
				uniqueId: 'model.pkg.gold__company',
				materialisation: 'table',
				packageName: 'pkg',
				path: 'models/gold__company.sql',
				schema: 'niclas_olofsson_gold',
				database: 'hive_metastore',
				tags: [],
				description: '',
			}],
			['model.pkg.mart_serving__chep', {
				name: 'mart_serving__chep',
				uniqueId: 'model.pkg.mart_serving__chep',
				materialisation: 'view',
				packageName: 'pkg',
				path: 'models/mart_serving__chep.sql',
				schema: 'niclas_olofsson_mart_serving',
				database: 'hive_metastore',
				tags: [],
				description: '',
			}],
		]);
		const sources = new Map([
			['source.pkg.raw.orders', {
				uniqueId: 'source.pkg.raw.orders',
				name: 'orders',
				sourceName: 'raw',
				schema: 'niclas_olofsson_raw',
				database: 'hive_metastore',
				tags: [],
				description: '',
			}],
		]);
		return {
			index: { adapterType: 'spark', models, sources },
			findModelsByName: () => [],
			getRawNode: () => null,
			getColumns: () => null,
			setColumns: vi.fn(),
			buildSchemaMapping: () => ({}),
		} as unknown as ManifestIndexer;
	}

	const emptyParseService = {
		getDocumentModel: vi.fn().mockResolvedValue(null),
		evict: vi.fn(),
	} as unknown as ParseService;

	it('returns schemas after catalog. (trailing dot)', async () => {
		const provider = new DbtCompletionProvider(makeIndexerWithFqnModels(), createMockLogger(), emptyParseService);
		const linePrefix = 'FROM hive_metastore.';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('niclas_olofsson_gold');
		expect(labels).toContain('niclas_olofsson_mart_serving');
		expect(labels).toContain('niclas_olofsson_raw');
	});

	it('returns table names after catalog.schema. (trailing dot)', async () => {
		const provider = new DbtCompletionProvider(makeIndexerWithFqnModels(), createMockLogger(), emptyParseService);
		const linePrefix = 'FROM hive_metastore.niclas_olofsson_gold.';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('gold__company');
		expect(labels).not.toContain('mart_serving__chep');
	});

	it('returns table names after catalog.schema.partial (no dot)', async () => {
		const provider = new DbtCompletionProvider(makeIndexerWithFqnModels(), createMockLogger(), emptyParseService);
		const linePrefix = 'FROM hive_metastore.niclas_olofsson_gold.gold__';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('gold__company');
	});

	it('works after JOIN keyword too', async () => {
		const provider = new DbtCompletionProvider(makeIndexerWithFqnModels(), createMockLogger(), emptyParseService);
		const linePrefix = 'JOIN hive_metastore.niclas_olofsson_mart_serving.';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('mart_serving__chep');
		expect(labels).not.toContain('gold__company');
	});

	it('does not pollute alias.column path for non-FROM context', async () => {
		const aliases = { c: ['id', 'name'] };
		const provider = new DbtCompletionProvider(makeIndexerWithFqnModels(), createMockLogger(), makeParseServiceWithAliases(aliases));
		// "SELECT c." — should still give column completions, not FQN
		const linePrefix = 'SELECT c.';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeDefined();
		const labels = items!.map(i => i.label);
		expect(labels).toContain('id');
		expect(labels).toContain('name');
		// No schema/table names should appear
		expect(labels).not.toContain('niclas_olofsson_gold');
	});
});
