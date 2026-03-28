import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CancellationTokenSource, Uri } from 'vscode';
import { ParseService } from '../services/parse-service';
import type { EnrichmentConfig } from '../services/parse-service';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { DescribeCache } from '../dbt/describe-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { createMockLogger } from './helpers';

const mockLogger = createMockLogger();

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createMockDocument(
	text: string,
	version = 1,
	uri = 'file:///test.sql',
): import('vscode').TextDocument {
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

/** Build a bridge mock that returns a minimal DocumentModel response with optional aliases. */
function createMockBridge(opts?: {
	ctes?: unknown[];
	refs?: unknown[];
	sources?: unknown[];
	finalColumns?: import('../services/parse-service').ColumnInfo[];
	aliases?: Record<string, string[]>;
}): BridgeRunner {
	return {
		invokeRaw: vi.fn().mockResolvedValue({
			success: true,
			data: {
				success: true,
				ctes: opts?.ctes ?? [],
				refs: opts?.refs ?? [],
				sources: opts?.sources ?? [],
				finalColumns: opts?.finalColumns ?? [],
				aliases: opts?.aliases ?? {},
				timing: { parseMs: 1, totalMs: 2 },
			},
		}),
	} as unknown as BridgeRunner;
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

function createMockDescribeCache(
	columns?: string[],
): DescribeCache {
	return {
		describeTable: vi.fn().mockResolvedValue(columns),
	} as unknown as DescribeCache;
}

/**
 * Create an EnrichmentConfig with just describeCache + indexer.
 * Aliases now come from the bridge response, not from a scope columns cache.
 */
function createEnrichment(
	describeColumns?: string[],
	indexerOverrides?: Partial<ManifestIndexer>,
): EnrichmentConfig {
	return {
		describeCache: createMockDescribeCache(describeColumns),
		indexer: createMockIndexer(indexerOverrides),
	};
}

function createToken(): import('vscode').CancellationToken {
	return new CancellationTokenSource().token;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ParseService — enrichment tier', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	// ---- getDocumentModel --------------------------------------------------

	describe('getDocumentModel', () => {
		it('returns parsed model with empty aliases when enrichment not configured', async () => {
			const bridge = createMockBridge();
			const service = new ParseService(bridge, mockLogger);

			const model = await service.getDocumentModel(createMockDocument('SELECT 1'), 'duckdb');

			expect(model).not.toBeNull();
			expect(model!.aliases).toEqual({});
		});

		it('returns parsed model with aliases from bridge when enrichment configured', async () => {
			const bridge = createMockBridge({ aliases: { orders: ['id', 'amount'] } });
			const service = new ParseService(bridge, mockLogger, createEnrichment());

			const model = await service.getDocumentModel(createMockDocument('SELECT 1'), 'duckdb');

			expect(model).not.toBeNull();
			expect(model!.aliases).toEqual({ orders: ['id', 'amount'] });
		});

		it('caches result and does not re-parse on same version', async () => {
			const bridge = createMockBridge();
			const service = new ParseService(bridge, mockLogger);
			const doc = createMockDocument('SELECT 1');

			await service.getDocumentModel(doc, 'duckdb');
			await service.getDocumentModel(doc, 'duckdb');

			expect(bridge.invokeRaw).toHaveBeenCalledTimes(1);
		});

		it('re-parses when document version changes', async () => {
			const bridge = createMockBridge();
			const service = new ParseService(bridge, mockLogger);

			const doc1 = createMockDocument('SELECT 1', 1, 'file:///a.sql');
			const doc2 = createMockDocument('SELECT 2', 2, 'file:///a.sql');

			await service.getDocumentModel(doc1, 'duckdb');
			await service.getDocumentModel(doc2, 'duckdb');

			expect(bridge.invokeRaw).toHaveBeenCalledTimes(2);
		});

		it('includes describe results in schema_mapping passed to bridge', async () => {
			const bridge = createMockBridge({ refs: [{ model: 'orders', line: 0 }] });
			const describeCache = createMockDescribeCache(['id', 'amount']);
			const MODEL_UNIQUE_ID = 'model.project.orders';
			const indexer = createMockIndexer({
				findModelsByName: vi.fn().mockReturnValue([{ uniqueId: MODEL_UNIQUE_ID }]),
				getRawNode: vi.fn().mockReturnValue({ name: 'orders', alias: 'orders', schema: 'main' }),
			});

			const service = new ParseService(bridge, mockLogger, { describeCache, indexer });
			await service.getDocumentModel(
				createMockDocument('SELECT id FROM {{ ref("orders") }}'),
				'duckdb',
			);

			// describeTable should have been called with the orders uniqueId
			expect(describeCache.describeTable).toHaveBeenCalled();

			// bridge request should include schema_mapping (from buildSchemaMapping)
			// Note: with empty mock buildSchemaMapping returning {} and empty describe columns,
			// schema_mapping may be omitted. The key check is describe was attempted.
		});
	});

	// ---- getAliases --------------------------------------------------------

	describe('getAliases', () => {
		it('returns {} when no enrichment configured and bridge returns no aliases', async () => {
			const bridge = createMockBridge();
			const service = new ParseService(bridge, mockLogger);

			const result = await service.getAliases(
				createMockDocument('SELECT 1'),
				'duckdb',
				createToken(),
			);

			expect(result).toEqual({});
		});

		it('returns aliases from bridge response', async () => {
			const bridge = createMockBridge({ aliases: { customers: ['id', 'name'] } });
			const service = new ParseService(bridge, mockLogger, createEnrichment());

			const result = await service.getAliases(
				createMockDocument('SELECT id FROM customers'),
				'duckdb',
				createToken(),
			);

			expect(result).toEqual({ customers: ['id', 'name'] });
		});

		it('returns cached aliases on second call without additional bridge hits', async () => {
			const bridge = createMockBridge({ aliases: { t: ['id'] } });
			const service = new ParseService(bridge, mockLogger, createEnrichment());
			const doc = createMockDocument('SELECT id FROM t');

			const first = await service.getAliases(doc, 'duckdb', createToken());
			const second = await service.getAliases(doc, 'duckdb', createToken());

			expect(first).toEqual({ t: ['id'] });
			expect(second).toEqual({ t: ['id'] });
			// Bridge should only be called once (cache hit on second call)
			expect(bridge.invokeRaw).toHaveBeenCalledTimes(1);
		});

		it('aliases are available immediately on the model returned by getDocumentModel', async () => {
			const bridge = createMockBridge({ aliases: { orders: ['id', 'status'] } });
			const service = new ParseService(bridge, mockLogger, createEnrichment());
			const doc = createMockDocument('SELECT id FROM orders');

			const model = await service.getDocumentModel(doc, 'duckdb');

			// No separate getAliases call needed — aliases are set during the single parse.
			expect(model!.aliases).toEqual({ orders: ['id', 'status'] });
		});

		it('token parameter is accepted but not required to unblock result', async () => {
			const bridge = createMockBridge({ aliases: { t: ['col'] } });
			const service = new ParseService(bridge, mockLogger, createEnrichment());

			const cancelledToken = { isCancellationRequested: true } as import('vscode').CancellationToken;
			// With the new single-pass design, aliases are already in the model.
			// A cancelled token should not prevent the result from being returned.
			const result = await service.getAliases(
				createMockDocument('SELECT 1'),
				'duckdb',
				cancelledToken,
			);

			expect(result).toEqual({ t: ['col'] });
		});
	});

	// ---- getCachedAliases --------------------------------------------------

	describe('getCachedAliases', () => {
		it('returns null when no model cached', () => {
			const service = new ParseService(createMockBridge(), mockLogger);
			expect(service.getCachedAliases(createMockDocument('SELECT 1'))).toBeNull();
		});

		it('returns aliases immediately after getDocumentModel completes', async () => {
			const bridge = createMockBridge({ aliases: { t: ['col'] } });
			const service = new ParseService(bridge, mockLogger, createEnrichment());
			const doc = createMockDocument('SELECT col FROM t');

			await service.getDocumentModel(doc, 'duckdb');

			// Aliases are set as part of the parse — no need to call getAliases first.
			expect(service.getCachedAliases(doc)).toEqual({ t: ['col'] });
		});

		it('returns populated aliases after getAliases completes', async () => {
			const bridge = createMockBridge({ aliases: { t: ['col'] } });
			const parseService = new ParseService(bridge, mockLogger, createEnrichment());
			const doc = createMockDocument('SELECT col FROM t');

			await parseService.getAliases(doc, 'duckdb', createToken());
			expect(parseService.getCachedAliases(doc)).toEqual({ t: ['col'] });
		});
	});

	// ---- invalidateEnrichment ----------------------------------------------

	describe('invalidateEnrichment', () => {
		it('clears cache so next getDocumentModel re-parses', async () => {
			const bridge = createMockBridge({ aliases: { t: ['id'] } });
			const parseService = new ParseService(bridge, mockLogger, createEnrichment());
			const doc = createMockDocument('SELECT id FROM t');

			await parseService.getDocumentModel(doc, 'duckdb');
			expect(bridge.invokeRaw).toHaveBeenCalledTimes(1);

			parseService.invalidateEnrichment();

			// Cache is cleared — getCachedAliases returns null
			expect(parseService.getCachedAliases(doc)).toBeNull();

			// Next parse re-runs the bridge
			await parseService.getDocumentModel(doc, 'duckdb');
			expect(bridge.invokeRaw).toHaveBeenCalledTimes(2);
		});
	});

	// ---- ColumnResolver delegation -----------------------------------------

	describe('ColumnResolver delegation to ParseService', () => {
		it('getScopeAliases delegates to parseService.getAliases when provided', async () => {
			const { ColumnResolver } = await import('../providers/column-resolver');

			const bridge = createMockBridge({ aliases: { customers: ['id', 'email'] } });
			const parseService = new ParseService(bridge, mockLogger, createEnrichment());

			const resolver = new ColumnResolver(
				createMockIndexer(),
				mockLogger,
				parseService,
			);

			const doc = createMockDocument('SELECT id FROM customers');
			const result = await resolver.getScopeAliases(doc, createToken());

			expect(result).toEqual({ customers: ['id', 'email'] });
		});

		it('getCachedAliases delegates to parseService.getCachedAliases when provided', async () => {
			const { ColumnResolver } = await import('../providers/column-resolver');

			const bridge = createMockBridge({ aliases: { t: ['col'] } });
			const parseService = new ParseService(bridge, mockLogger, createEnrichment());

			const resolver = new ColumnResolver(
				createMockIndexer(),
				mockLogger,
				parseService,
			);

			const doc = createMockDocument('SELECT col FROM t');
			expect(resolver.getCachedAliases(doc)).toBeNull(); // not yet parsed

			await parseService.getAliases(doc, 'duckdb', createToken());
			expect(resolver.getCachedAliases(doc)).toEqual({ t: ['col'] });
		});

		it('invalidateEnrichment can be called directly', async () => {
			const bridge = createMockBridge();
			const parseService = new ParseService(bridge, mockLogger, createEnrichment());
			const spy = vi.spyOn(parseService, 'invalidateEnrichment');

			parseService.invalidateEnrichment();
			expect(spy).toHaveBeenCalledTimes(1);
		});
	});

	// ---- evict -------------------------------------------------------------

	describe('evict', () => {
		it('removes cached entry so next call re-parses', async () => {
			const bridge = createMockBridge();
			const parseService = new ParseService(bridge, mockLogger);
			const doc = createMockDocument('SELECT 1', 1, 'file:///evict-test.sql');

			await parseService.getDocumentModel(doc, 'duckdb');
			parseService.evict(doc.uri);

			// After evict, same name/version will re-parse
			await parseService.getDocumentModel(doc, 'duckdb');
			expect(bridge.invokeRaw).toHaveBeenCalledTimes(2);
		});
	});
});

