import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { DbtHoverProvider } from '../providers/hover-provider';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ColumnResolver } from '../providers/column-resolver';
import type { ParseService, DocumentModel } from '../services/parse-service';
import { createMockLogger } from './helpers';

// ─── helpers ─────────────────────────────────────────────────────────────────

function createMockDocument(content: string): vscode.TextDocument {
	const lines = content.split('\n');
	return {
		languageId: 'jinja-sql',
		fileName: '/project/models/customers.sql',
		getText: vi.fn((range?: vscode.Range) => {
			if (!range) return content;
			if (range.start.line === range.end.line) {
				return (lines[range.start.line] ?? '').substring(range.start.character, range.end.character);
			}
			const parts = [lines[range.start.line]?.substring(range.start.character) ?? ''];
			for (let i = range.start.line + 1; i < range.end.line; i++) parts.push(lines[i]);
			parts.push((lines[range.end.line] ?? '').substring(0, range.end.character));
			return parts.join('\n');
		}),
		lineAt: vi.fn((line: number) => ({
			text: lines[line] ?? '',
			range: new vscode.Range(line, 0, line, (lines[line] ?? '').length),
		})),
		positionAt: vi.fn((offset: number) => {
			let remaining = offset;
			for (let i = 0; i < lines.length; i++) {
				if (remaining <= lines[i].length) {
					return new vscode.Position(i, remaining);
				}
				remaining -= lines[i].length + 1;
			}
			return new vscode.Position(lines.length - 1, 0);
		}),
		getWordRangeAtPosition: vi.fn((pos: vscode.Position, pattern?: RegExp) => {
			const line = lines[pos.line] ?? '';
			const re = pattern ?? /[a-zA-Z_]\w*/g;
			const global = new RegExp(re.source, 'g');
			let m;
			while ((m = global.exec(line)) !== null) {
				if (pos.character >= m.index && pos.character <= m.index + m[0].length) {
					return new vscode.Range(pos.line, m.index, pos.line, m.index + m[0].length);
				}
			}
			return undefined;
		}),
		lineCount: lines.length,
		uri: vscode.Uri.file('/project/models/customers.sql'),
		version: 1,
	} as unknown as vscode.TextDocument;
}

function createMockIndexer(): ManifestIndexer {
	return {
		index: { adapterType: 'duckdb', models: new Map(), sources: new Map(), macros: new Map(), nodesByName: new Map() },
		findModelsByName: () => [],
		getRawNode: () => null,
		getColumns: () => null,
		setColumns: vi.fn(),
		buildSchemaMapping: () => ({}),
	} as unknown as ManifestIndexer;
}

function createMockParseService(model: DocumentModel | undefined): ParseService {
	return {
		getDocumentModel: vi.fn().mockResolvedValue(model),
		evict: vi.fn(),
	} as unknown as ParseService;
}

const mockToken: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: vi.fn(),
};

// ─── CTE hover (Phase 4) ────────────────────────────────────────────────────

describe('DbtHoverProvider — CTE hover via ParseService', () => {
	const sql = [
		'WITH base AS (',
		'  SELECT id, name, email',
		'  FROM raw_customers',
		'),',
		'enriched AS (',
		'  SELECT id, name',
		'  FROM base',
		')',
		'SELECT * FROM enriched',
	].join('\n');

	const model: DocumentModel = {
		ctes: [
			{ name: 'base', line: 0, endLine: 3, columns: [{ name: 'id', line: 1 }, { name: 'name', line: 1 }, { name: 'email', line: 1 }] },
			{ name: 'enriched', line: 4, endLine: 7, columns: [{ name: 'id', line: 5 }, { name: 'name', line: 5 }] },
		],
		refs: [],
		sources: [],
		finalColumns: [{ name: 'id', line: 8 }, { name: 'name', line: 8 }],
		timing: { parseMs: 5, totalMs: 10 },
	};

	it('shows CTE columns on hover over FROM cte_name', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtHoverProvider(
			createMockIndexer(), createMockLogger(),
			undefined, parseService,
		);
		const doc = createMockDocument(sql);
		// Line 6: "  FROM base" — cursor on 'base'
		const pos = new vscode.Position(6, 9);

		const result = await provider.provideHover(doc, pos, mockToken);

		expect(result).toBeDefined();
		const content = (result!.contents as unknown as vscode.MarkdownString).value;
		expect(content).toContain('base');
		expect(content).toContain('CTE');
		expect(content).toContain('3 columns');
		expect(content).toContain('id');
		expect(content).toContain('name');
		expect(content).toContain('email');
	});

	it('shows CTE columns on hover over final FROM enriched', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtHoverProvider(
			createMockIndexer(), createMockLogger(),
			undefined, parseService,
		);
		const doc = createMockDocument(sql);
		// Line 8: "SELECT * FROM enriched"
		const pos = new vscode.Position(8, 17);

		const result = await provider.provideHover(doc, pos, mockToken);

		expect(result).toBeDefined();
		const content = (result!.contents as unknown as vscode.MarkdownString).value;
		expect(content).toContain('enriched');
		expect(content).toContain('2 columns');
	});

	it('does not trigger CTE hover when not after FROM/JOIN', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtHoverProvider(
			createMockIndexer(), createMockLogger(),
			undefined, parseService,
		);
		const doc = createMockDocument(sql);
		// Line 1: "  SELECT id, name, email" — cursor on 'id'
		const pos = new vscode.Position(1, 11);

		const result = await provider.provideHover(doc, pos, mockToken);

		// No CTE hover for id in SELECT (not after FROM/JOIN)
		expect(result).toBeUndefined();
	});

	it('returns undefined when ParseService has no matching CTE', async () => {
		const emptyModel: DocumentModel = {
			ctes: [], refs: [], sources: [], finalColumns: [] as import('../services/parse-service').ColumnInfo[],
			timing: { parseMs: 1, totalMs: 2 },
		};
		const parseService = createMockParseService(emptyModel);
		const provider = new DbtHoverProvider(
			createMockIndexer(), createMockLogger(),
			undefined, parseService,
		);
		const doc = createMockDocument(sql);
		// Line 6: "  FROM base" but model has no CTEs
		const pos = new vscode.Position(6, 9);

		const result = await provider.provideHover(doc, pos, mockToken);

		expect(result).toBeUndefined();
	});
});
