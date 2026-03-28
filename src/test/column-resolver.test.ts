import { describe, it, expect, vi } from 'vitest';
import { CancellationTokenSource, Uri } from 'vscode';
import { ColumnResolver } from '../providers/column-resolver';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ParseService } from '../services/parse-service';
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

function createMockIndexer(): ManifestIndexer {
	return {
		index: { adapterType: 'duckdb' },
	} as unknown as ManifestIndexer;
}

function createMockParseService(overrides?: Partial<ParseService>): ParseService {
	return {
		getDocumentModel: vi.fn().mockResolvedValue({ ctes: [], refs: [], sources: [], finalColumns: [], tokens: [], timing: { parseMs: 0, totalMs: 0 }, aliases: {} }),
		getCachedAliases: vi.fn().mockReturnValue(null),
		invalidateEnrichment: vi.fn(),
		...overrides,
	} as unknown as ParseService;
}

describe('ColumnResolver', () => {
	it('getScopeAliases calls getDocumentModel and resolves aliases', async () => {
		const aliases = { orders: ['id', 'status'] };
		const model = { ctes: [], refs: [], sources: [], finalColumns: [], tokens: [], timing: { parseMs: 0, totalMs: 0 }, aliases };
		const parseService = createMockParseService({ getDocumentModel: vi.fn().mockResolvedValue(model) });
		const resolver = new ColumnResolver(createMockIndexer(), mockLogger, parseService);
		const doc = createMockDocument('SELECT id FROM orders');
		const token = new CancellationTokenSource().token;

		const result = await resolver.getScopeAliases(doc, token);

		expect(result).toMatchObject(aliases);
		expect(parseService.getDocumentModel).toHaveBeenCalledWith(doc, 'duckdb');
	});

	it('getCachedAliases delegates to parseService.getCachedAliases', () => {
		const aliases = { t: ['col'] };
		const parseService = createMockParseService({ getCachedAliases: vi.fn().mockReturnValue(aliases) });
		const resolver = new ColumnResolver(createMockIndexer(), mockLogger, parseService);
		const doc = createMockDocument('SELECT 1');

		const result = resolver.getCachedAliases(doc);

		expect(result).toEqual(aliases);
		expect(parseService.getCachedAliases).toHaveBeenCalledWith(doc);
	});

	it('getCachedAliases returns null when parseService has no cached entry', () => {
		const parseService = createMockParseService({ getCachedAliases: vi.fn().mockReturnValue(null) });
		const resolver = new ColumnResolver(createMockIndexer(), mockLogger, parseService);

		expect(resolver.getCachedAliases(createMockDocument('SELECT 1'))).toBeNull();
	});
});

