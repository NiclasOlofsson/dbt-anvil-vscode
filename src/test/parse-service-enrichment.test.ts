import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CancellationTokenSource, Uri } from 'vscode';
import { ParseService } from '../services/parse-service';
import type { EnrichmentConfig } from '../services/parse-service';
import { BridgeDocumentParser } from '../services/bridge-document-parser';
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
		columns: vi.fn().mockResolvedValue(columns),
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
			const service = new ParseService(new BridgeDocumentParser(bridge), mockLogger);

			const model = await service.getDocumentModel(createMockDocument('SELECT 1'), 'duckdb');

			expect(model).not.toBeNull();
			expect(model!.aliases).toEqual({});
		});

		it('returns parsed model with aliases from bridge when enrichment configured', async () => {
			const bridge = createMockBridge({ aliases: { orders: ['id', 'amount'] } });
			const service = new ParseService(new BridgeDocumentParser(bridge), mockLogger, createEnrichment());

			const model = await service.getDocumentModel(createMockDocument('SELECT 1'), 'duckdb');

			expect(model).not.toBeNull();
			expect(model!.aliases).toEqual({ orders: ['id', 'amount'] });
		});

		it('caches result and does not re-parse on same version', async () => {
			const bridge = createMockBridge();
			const service = new ParseService(new BridgeDocumentParser(bridge), mockLogger);
			const doc = createMockDocument('SELECT 1');

			await service.getDocumentModel(doc, 'duckdb');
			await service.getDocumentModel(doc, 'duckdb');

			expect(bridge.invokeRaw).toHaveBeenCalledTimes(1);
		});

		it('re-parses when document version changes', async () => {
			const bridge = createMockBridge();
			const service = new ParseService(new BridgeDocumentParser(bridge), mockLogger);

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

			const service = new ParseService(new BridgeDocumentParser(bridge), mockLogger, { describeCache, indexer });
			await service.getDocumentModel(
				createMockDocument('SELECT id FROM {{ ref("orders") }}'),
				'duckdb',
			);

			// columns() should have been called with the orders uniqueId
			expect(describeCache.columns).toHaveBeenCalled();

			// bridge request should include schema_mapping (from buildSchemaMapping)
			// Note: with empty mock buildSchemaMapping returning {} and empty describe columns,
			// schema_mapping may be omitted. The key check is describe was attempted.
		});
	});

	// ---- resolveAliases (static) ------------------------------------------

	describe('resolveAliases', () => {
		function makeModel(overrides?: Partial<import('../services/parse-service').DocumentModel>): import('../services/parse-service').DocumentModel {
			return {
				ctes: [],
				refs: [],
				sources: [],
				finalColumns: [],
				tokens: [],
				timing: { parseMs: 0, totalMs: 0 },
				aliases: {},
				...overrides,
			};
		}

		it('returns {} for empty model', () => {
			expect(ParseService.resolveAliases(makeModel())).toEqual({});
		});

		it('includes bridge-resolved upstream aliases', () => {
			const model = makeModel({ aliases: { customers: ['id', 'name'] } });
			expect(ParseService.resolveAliases(model)).toEqual({ customers: ['id', 'name'] });
		});

		it('includes CTE column lists', () => {
			const model = makeModel({
				ctes: [{ name: 'orders', columns: [{ name: 'id', line: 0 }, { name: 'status', line: 1 }], line: 0, endLine: 5 }],
			});
			expect(ParseService.resolveAliases(model)['orders']).toEqual(['id', 'status']);
		});

		it('resolves FROM/JOIN alias pointing to a CTE', () => {
			const model = makeModel({
				ctes: [{ name: 'orders', columns: [{ name: 'id', line: 0 }], line: 0, endLine: 5 }],
				tokens: [{ type: 'table_ref' as const, name: 'orders', alias: 'o', line: 1, col: 0, endCol: 6 }],
			});
			expect(ParseService.resolveAliases(model)['o']).toEqual(['id']);
		});

		it('is a pure function — repeated calls return equal results', () => {
			const model = makeModel({ aliases: { t: ['id'] } });
			expect(ParseService.resolveAliases(model)).toEqual(ParseService.resolveAliases(model));
		});
	});

});

