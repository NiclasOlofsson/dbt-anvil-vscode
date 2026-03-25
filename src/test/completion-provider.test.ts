import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ColumnResolver } from '../providers/column-resolver';

import { DbtCompletionProvider } from '../providers/completion-provider';
import { createMockLogger } from './helpers';

// ─── helpers ─────────────────────────────────────────────────────────────────

function mockDocument(lines: string[], version = 1) {
	return {
		getText: () => lines.join('\n'),
		lineAt: (line: number) => ({ text: lines[line] ?? '' }),
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

function makeColumnResolver(aliases: Record<string, string[]>): ColumnResolver {
	return {
		getScopeAliases: vi.fn().mockResolvedValue(aliases),
		getCachedAliases: vi.fn().mockReturnValue(aliases),
		invalidateCache: vi.fn(),
	} as unknown as ColumnResolver;
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
		provider = new DbtCompletionProvider(makeIndexer(), createMockLogger(), makeColumnResolver(aliases));
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

	it('skips bare column completions after FROM keyword', async () => {
		const linePrefix = 'FROM cu';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		// Should return undefined (no branch matched) rather than column completions
		expect(items).toBeUndefined();
	});

	it('skips bare column completions after JOIN keyword', async () => {
		const linePrefix = 'JOIN ord';
		const doc = mockDocument([linePrefix]);
		const pos = { line: 0, character: linePrefix.length };

		const items = await provider.provideCompletionItems(doc as any, pos as any, TOKEN as any, CTX as any);

		expect(items).toBeUndefined();
	});

	it('returns [] (not undefined) when no aliases resolved', async () => {
		const emptyResolver = makeColumnResolver({});
		const p = new DbtCompletionProvider(makeIndexer(), createMockLogger(), emptyResolver);

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
		const provider = new DbtCompletionProvider(makeIndexer(), createMockLogger(), makeColumnResolver(aliases));

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
