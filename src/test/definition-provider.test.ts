import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { DbtDefinitionProvider } from '../providers/definition-provider';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ParseService, DocumentModel, TokenInfo } from '../services/parse-service';
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

function createMockLoader(): ManifestLoader {
	return {
		projectDir: '/project',
	} as unknown as ManifestLoader;
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

// ─── CTE navigation (Phase 1): F12 on FROM/JOIN cte_name ────────────────────

describe('DbtDefinitionProvider — CTE navigation via ParseService', () => {
	const sql = [
		'WITH base AS (',
		'  SELECT id, name',
		'  FROM raw_customers',
		'),',
		'enriched AS (',
		'  SELECT id, name, email',
		'  FROM base',
		')',
		'SELECT * FROM enriched',
	].join('\n');

	const model: DocumentModel = {
		ctes: [
			{ name: 'base', line: 0, endLine: 3, columns: [{ name: 'id', line: 1 }, { name: 'name', line: 1 }] },
			{ name: 'enriched', line: 4, endLine: 7, columns: [{ name: 'id', line: 5 }, { name: 'name', line: 5 }, { name: 'email', line: 5 }] },
		],
		refs: [],
		sources: [],
		finalColumns: [{ name: 'id', line: 8 }, { name: 'name', line: 8 }, { name: 'email', line: 8 }],
		tokens: [
			{ type: 'table_ref', name: 'raw_customers', line: 2, col: 7, endCol: 21 },
			{ type: 'table_ref', name: 'base', line: 6, col: 7, endCol: 11 },
			{ type: 'table_ref', name: 'enriched', line: 8, col: 14, endCol: 22 },
		] as TokenInfo[],
		timing: { parseMs: 5, totalMs: 10 },
	};

	it('F12 on FROM base jumps to CTE definition line', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtDefinitionProvider(
			createMockIndexer(), createMockLoader(), createMockLogger(),
			parseService,
		);
		const doc = createMockDocument(sql);
		// Line 6: "  FROM base" — cursor on 'base' at character 7
		const pos = new vscode.Position(6, 9);

		const result = await provider.provideDefinition(doc, pos, mockToken);

		expect(result).toBeDefined();
		const loc = result as vscode.Location;
		const startLine = loc.range instanceof vscode.Position ? loc.range.line : loc.range.start.line;
		expect(startLine).toBe(0); // base CTE starts at line 0
	});

	it('F12 on FROM enriched jumps to CTE definition line', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtDefinitionProvider(
			createMockIndexer(), createMockLoader(), createMockLogger(),
			parseService,
		);
		const doc = createMockDocument(sql);
		// Line 8: "SELECT * FROM enriched" — cursor on 'enriched'
		const pos = new vscode.Position(8, 17);

		const result = await provider.provideDefinition(doc, pos, mockToken);

		expect(result).toBeDefined();
		const loc = result as vscode.Location;
		const startLine = loc.range instanceof vscode.Position ? loc.range.line : loc.range.start.line;
		expect(startLine).toBe(4); // enriched CTE starts at line 4
	});

	it('does not trigger when cursor is not after FROM/JOIN', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtDefinitionProvider(
			createMockIndexer(), createMockLoader(), createMockLogger(),
			parseService,
		);
		const doc = createMockDocument(sql);
		// Line 1: "  SELECT id, name" — cursor on 'id' (not after FROM/JOIN)
		const pos = new vscode.Position(1, 11);

		const result = await provider.provideDefinition(doc, pos, mockToken);

		expect(result).toBeUndefined();
	});
});

// ─── Column go-to-definition (Phase 2): alias.column → parsed position ──────

describe('DbtDefinitionProvider — column go-to-definition via ParseService', () => {
	const sql = [
		'WITH base AS (',
		'  SELECT',
		'    id,',
		'    name,',
		'    email',
		'  FROM raw_customers',
		')',
		'SELECT base.name FROM base',
	].join('\n');

	const model: DocumentModel = {
		ctes: [
			{
				name: 'base', line: 0, endLine: 6,
				columns: [
					{ name: 'id', line: 2 },
					{ name: 'name', line: 3 },
					{ name: 'email', line: 4 },
				],
			},
		],
		refs: [],
		sources: [],
		finalColumns: [{ name: 'name', line: 8 }],
		tokens: [
			// Line 7: "SELECT base.name FROM base"
			// base.name → column_ref with table qualifier
			{ type: 'column_ref', name: 'name', line: 7, col: 12, endCol: 16, table: 'base', tableLine: 7, tableCol: 7, tableEndCol: 11 },
			// FROM base → table_ref
			{ type: 'table_ref', name: 'base', line: 7, col: 22, endCol: 26 },
		] as TokenInfo[],
		timing: { parseMs: 5, totalMs: 10 },
	};

	it('F12 on alias.column jumps to column line in CTE via ParseService', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtDefinitionProvider(
			createMockIndexer(), createMockLoader(), createMockLogger(),
			parseService,
		);
		const doc = createMockDocument(sql);
		// Line 7: "SELECT base.name FROM base" — cursor on 'name' (the column part)
		const pos = new vscode.Position(7, 14);

		const result = await provider.provideDefinition(doc, pos, mockToken);

		expect(result).toBeDefined();
		const loc = result as vscode.Location;
		const startLine = loc.range instanceof vscode.Position ? loc.range.line : loc.range.start.line;
		expect(startLine).toBe(3); // 'name' column is on line 3
	});

	it('F12 on alias name jumps to CTE definition via ParseService', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtDefinitionProvider(
			createMockIndexer(), createMockLoader(), createMockLogger(),
			parseService,
		);
		const doc = createMockDocument(sql);
		// Line 7: "SELECT base.name FROM base" — cursor on 'base' (the alias part)
		const pos = new vscode.Position(7, 9);

		const result = await provider.provideDefinition(doc, pos, mockToken);

		expect(result).toBeDefined();
		const loc = result as vscode.Location;
		const startLine = loc.range instanceof vscode.Position ? loc.range.line : loc.range.start.line;
		expect(startLine).toBe(0); // base CTE starts at line 0
	});
});
