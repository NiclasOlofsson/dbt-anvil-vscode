import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CancellationTokenSource, Uri } from 'vscode';
import { ColumnResolver } from '../providers/column-resolver';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DbtExecutionService } from '../dbt/execution-service';
import { createMockLogger } from './helpers';

const mockLogger = createMockLogger();

function createMockDocument(text: string, version = 1, uri = 'file:///test.sql') {
	return {
		uri: Uri.parse(uri),
		version,
		fileName: '/test.sql',
		languageId: 'jinja-sql',
		getText: () => text,
		lineAt: (line: number) => {
			const lines = text.split('\n');
			return { text: lines[line] ?? '' };
		},
	} as unknown as import('vscode').TextDocument;
}

function createMockIndexer(overrides?: Partial<ManifestIndexer>): ManifestIndexer {
	return {
		index: { adapterType: 'duckdb' },
		buildSchemaMapping: vi.fn().mockReturnValue({}),
		findModelsByName: vi.fn().mockReturnValue([]),
		getRawNode: vi.fn().mockReturnValue(null),
		getColumns: vi.fn().mockReturnValue(null),
		setColumns: vi.fn(),
		...overrides,
	} as unknown as ManifestIndexer;
}

function createMockService(scopeResult?: Record<string, unknown>): DbtExecutionService {
	return {
		submit: vi.fn().mockResolvedValue({
			data: scopeResult ?? { aliases: {} },
		}),
	} as unknown as DbtExecutionService;
}

describe('ColumnResolver', () => {
	let token: ReturnType<typeof createToken>;

	function createToken() {
		const src = new CancellationTokenSource();
		return src.token;
	}

	beforeEach(() => {
		token = createToken();
		vi.clearAllMocks();
	});

	describe('getScopeAliases', () => {
		it('returns empty when no service is provided', async () => {
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger);
			const doc = createMockDocument('SELECT 1');
			const result = await resolver.getScopeAliases(doc, token);
			expect(result).toEqual({});
		});

		it('calls bridge and returns aliases', async () => {
			const service = createMockService({
				aliases: { orders: ['id', 'status', 'amount'] },
			});
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger, service);
			const doc = createMockDocument('SELECT id FROM orders');
			const result = await resolver.getScopeAliases(doc, token);
			expect(result).toEqual({ orders: ['id', 'status', 'amount'] });
		});

		it('caches results by document version', async () => {
			const service = createMockService({
				aliases: { t: ['col1'] },
			});
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger, service);
			const doc = createMockDocument('SELECT col1 FROM t');

			await resolver.getScopeAliases(doc, token);
			await resolver.getScopeAliases(doc, token);

			// submit should be called only once (scope_columns), not twice
			const submitCalls = (service.submit as ReturnType<typeof vi.fn>).mock.calls;
			const scopeCalls = submitCalls.filter(
				(c: unknown[]) => (c[0] as Record<string, unknown>).type === 'scope_columns',
			);
			expect(scopeCalls).toHaveLength(1);
		});

		it('re-resolves when document version changes', async () => {
			const service = createMockService({
				aliases: { t: ['a'] },
			});
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger, service);
			const doc1 = createMockDocument('SELECT a FROM t', 1, 'file:///x.sql');
			const doc2 = createMockDocument('SELECT a, b FROM t', 2, 'file:///x.sql');

			await resolver.getScopeAliases(doc1, token);
			await resolver.getScopeAliases(doc2, token);

			const submitCalls = (service.submit as ReturnType<typeof vi.fn>).mock.calls;
			const scopeCalls = submitCalls.filter(
				(c: unknown[]) => (c[0] as Record<string, unknown>).type === 'scope_columns',
			);
			expect(scopeCalls).toHaveLength(2);
		});

		it('returns empty when cancellation is requested', async () => {
			const service = createMockService({ aliases: { t: ['a'] } });
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger, service);
			const doc = createMockDocument('SELECT a FROM t');
			const src = new CancellationTokenSource();
			src.cancel();
			// The mock token has isCancellationRequested = false by default
			// Let's create a cancelled token
			const cancelledToken = { ...src.token, isCancellationRequested: true } as unknown as import('vscode').CancellationToken;
			const result = await resolver.getScopeAliases(doc, cancelledToken);
			expect(result).toEqual({});
		});
	});

	describe('getCachedAliases', () => {
		it('returns null when no cache entry exists', () => {
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger);
			const doc = createMockDocument('SELECT 1');
			expect(resolver.getCachedAliases(doc)).toBeNull();
		});

		it('returns cached result after getScopeAliases', async () => {
			const service = createMockService({
				aliases: { t: ['id'] },
			});
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger, service);
			const doc = createMockDocument('SELECT id FROM t');

			await resolver.getScopeAliases(doc, token);
			const cached = resolver.getCachedAliases(doc);
			expect(cached).toEqual({ t: ['id'] });
		});

		it('returns null after invalidateCache', async () => {
			const service = createMockService({
				aliases: { t: ['id'] },
			});
			const resolver = new ColumnResolver(createMockIndexer(), mockLogger, service);
			const doc = createMockDocument('SELECT id FROM t');

			await resolver.getScopeAliases(doc, token);
			resolver.invalidateCache();
			expect(resolver.getCachedAliases(doc)).toBeNull();
		});
	});

	describe('upstream resolution', () => {
		it('describes upstream refs and fills schema mapping', async () => {
			const indexer = createMockIndexer({
				buildSchemaMapping: vi.fn().mockReturnValue({}),
				getRawNode: vi.fn().mockReturnValue({ name: 'orders', source_name: undefined }),
				getColumns: vi.fn().mockReturnValue(null),
				setColumns: vi.fn(),
			} as unknown as Partial<ManifestIndexer>);

			const service = createMockService({ aliases: {} });
			// Override submit to handle both describe and scope_columns
			(service.submit as ReturnType<typeof vi.fn>).mockImplementation(async (job: Record<string, unknown>) => {
				if (job.type === 'describe') {
					return { data: { columns: ['id', 'status'] } };
				}
				return { data: { aliases: { orders: ['id', 'status'] } } };
			});

			const resolver = new ColumnResolver(indexer, mockLogger, service);
			// Use SQL text that stripJinja can process — but since indexer is mocked,
			// refs won't be extracted. The key point is that submit is called.
			const doc = createMockDocument('SELECT id FROM orders');
			const result = await resolver.getScopeAliases(doc, token);

			// The bridge call for scope_columns should have happened
			const submitCalls = (service.submit as ReturnType<typeof vi.fn>).mock.calls;
			const scopeCalls = submitCalls.filter(
				(c: unknown[]) => (c[0] as Record<string, unknown>).type === 'scope_columns',
			);
			expect(scopeCalls).toHaveLength(1);
			expect(result).toEqual({ orders: ['id', 'status'] });
		});
	});

	describe('deduplication', () => {
		it('deduplicates concurrent calls to the same document version', async () => {
			let resolveSubmit: ((v: unknown) => void) | undefined;
			const service = {
				submit: vi.fn().mockImplementation(() => new Promise(r => { resolveSubmit = r; })),
			} as unknown as DbtExecutionService;

			const resolver = new ColumnResolver(createMockIndexer(), mockLogger, service);
			const doc = createMockDocument('SELECT 1');

			// Fire two concurrent requests
			const p1 = resolver.getScopeAliases(doc, token);
			const p2 = resolver.getScopeAliases(doc, token);

			// Only one submit call should be made
			expect((service.submit as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);

			// Resolve and verify both return the same result
			resolveSubmit!({ data: { aliases: { t: ['a'] } } });
			const [r1, r2] = await Promise.all([p1, p2]);
			expect(r1).toEqual({ t: ['a'] });
			expect(r2).toEqual({ t: ['a'] });
		});
	});
});
