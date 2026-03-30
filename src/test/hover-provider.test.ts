import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { DbtHoverProvider } from '../providers/sql/hover-provider';
import { ParseService } from '../services/parse-service';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DocumentModel, TokenInfo } from '../services/parse-service';
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
		tokens: [
			// Line 2: "  FROM raw_customers"
			{ type: 'table_ref', name: 'raw_customers', line: 2, col: 7, endCol: 21 },
			// Line 6: "  FROM base"
			{ type: 'table_ref', name: 'base', line: 6, col: 7, endCol: 11 },
			// Line 8: "SELECT * FROM enriched"
			{ type: 'table_ref', name: 'enriched', line: 8, col: 14, endCol: 22 },
		] as TokenInfo[],
		timing: { parseMs: 5, totalMs: 10 },
	};

	it('shows CTE columns on hover over FROM cte_name', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtHoverProvider(
			createMockIndexer(), createMockLogger(),
			parseService,
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
			parseService,
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

	it('does not trigger CTE table hover when hovering a column in SELECT', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtHoverProvider(
			createMockIndexer(), createMockLogger(),
			parseService,
		);
		const doc = createMockDocument(sql);
		// Line 1: "  SELECT id, name, email" — cursor on 'id'
		const pos = new vscode.Position(1, 11);

		const result = await provider.provideHover(doc, pos, mockToken);

		// No CTE table hover for 'id' in SELECT — if anything fires it must be a column hover
		if (result) {
			const content = (result.contents as unknown as vscode.MarkdownString).value;
			expect(content).not.toMatch(/— CTE\b/);
			expect(content).toContain('— column');
		}
	});

	it('returns undefined when ParseService has no matching CTE', async () => {
		const emptyModel: DocumentModel = {
			ctes: [], refs: [], sources: [], finalColumns: [] as import('../services/parse-service').ColumnInfo[],
			tokens: [
				// Token exists but no matching CTE in the model
				{ type: 'table_ref', name: 'base', line: 6, col: 7, endCol: 11 },
			] as TokenInfo[],
			timing: { parseMs: 1, totalMs: 2 },
		};
		const parseService = createMockParseService(emptyModel);
		const provider = new DbtHoverProvider(
			createMockIndexer(), createMockLogger(),
			parseService,
		);
		const doc = createMockDocument(sql);
		// Line 6: "  FROM base" but model has no CTEs
		const pos = new vscode.Position(6, 9);

		const result = await provider.provideHover(doc, pos, mockToken);

		expect(result).toBeUndefined();
	});
});

// ─── Wildcard column list hover ──────────────────────────────────────────────

describe('DbtHoverProvider — wildcard column list (*)', () => {
	// CTE that does SELECT * exposes all columns — the column list contains '*'.
	// Hovering addr.street where addr resolves to such a CTE should still show
	// a column hover, not silently return nothing.
	const sql = [
		'WITH addr_cte AS (',
		'  SELECT * FROM {{ ref("gold__address") }}',
		'),',
		'enriched AS (',
		'  SELECT addr.street',
		'  FROM addr_cte AS addr',
		')',
		'SELECT * FROM enriched',
	].join('\n');

	const addrRef: import('../services/parse-service').TableRefToken = {
		type: 'table_ref', name: 'addr_cte', alias: 'addr', line: 5, col: 7, endCol: 22,
	};

	const model: DocumentModel = {
		ctes: [
			{ name: 'addr_cte', line: 0, endLine: 2, columns: [{ name: '*', line: 1 }] },
			{ name: 'enriched', line: 3, endLine: 6, columns: [{ name: 'street', line: 4 }] },
		],
		refs: [],
		sources: [],
		finalColumns: [],
		tokens: [
			addrRef,
			{
				type: 'column_ref',
				name: 'street',
				table: 'addr',
				line: 4,
				col: 9,
				endCol: 15,
				resolvedTableRef: addrRef,
			},
		] as TokenInfo[],
		timing: { parseMs: 1, totalMs: 2 },
	};

	it('shows column hover for qualified column when CTE has wildcard column list', async () => {
		const parseService = createMockParseService(model);
		const provider = new DbtHoverProvider(createMockIndexer(), createMockLogger(), parseService);
		const doc = createMockDocument(sql);
		// Line 4: "  SELECT addr.street" — cursor on 'street'
		const pos = new vscode.Position(4, 14);

		const result = await provider.provideHover(doc, pos, mockToken);

		expect(result).toBeDefined();
		const content = (result!.contents as unknown as vscode.MarkdownString).value;
		expect(content).toContain('street');
		expect(content).toContain('— column');
		expect(content).toContain('addr_cte'); // lineage chain shows CTE name
	});
});

// ─── ParseService.traceCteLineage unit tests ─────────────────────────────────

describe('ParseService.traceCteLineage', () => {
	// Model shape:
	//   address_with_country AS (             -- line 0..2
	//     SELECT * FROM ref('gold__address')  -- ref token at line 1
	//   ),                                    -- line 2
	//   warehouses_enriched AS (              -- line 3..7
	//     SELECT addr.street
	//     FROM address_with_country AS addr   -- table_ref at line 5
	//   )
	//   SELECT * FROM warehouses_enriched     -- table_ref at line 8

	const addrCteRef: import('../services/parse-service').TableRefToken = {
		type: 'table_ref', name: 'address_with_country', alias: 'addr', line: 5, col: 9, endCol: 36,
	};
	const goldAddressRef: import('../services/parse-service').TableRefToken = {
		type: 'table_ref', name: 'gold__address', line: 1, col: 18, endCol: 31,
	};
	const warehousesRef: import('../services/parse-service').TableRefToken = {
		type: 'table_ref', name: 'warehouses_enriched', line: 8, col: 14, endCol: 32,
	};

	const model: DocumentModel = {
		ctes: [
			{ name: 'address_with_country', line: 0, endLine: 2, columns: [{ name: '*', line: 1 }] },
			{ name: 'warehouses_enriched', line: 3, endLine: 7, columns: [{ name: 'street', line: 4 }] },
		],
		refs: [{ model: 'gold__address', line: 1, col: 18 }],
		sources: [],
		finalColumns: [],
		tokens: [goldAddressRef, addrCteRef, warehousesRef] as TokenInfo[],
		timing: { parseMs: 1, totalMs: 2 },
	};

	it('returns single-hop chain when CTE wraps a ref', () => {
		// addr → address_with_country (CTE) → ref('gold__address')
		const chain = ParseService.traceCteLineage(addrCteRef, model);
		expect(chain).toEqual(['address_with_country', "ref('gold__address')"]);
	});

	it('returns just the CTE name when it has no upstream table_ref in its body', () => {
		const isolatedModel: DocumentModel = {
			...model,
			tokens: [addrCteRef], // no goldAddressRef in body
		};
		const chain = ParseService.traceCteLineage(addrCteRef, isolatedModel);
		expect(chain).toEqual(['address_with_country']);
	});

	it('returns [name] for a non-CTE external table_ref with no alias', () => {
		// warehousesRef is not a CTE name — no CTE named 'warehouses_enriched' in the ctes list?
		// Actually it IS a CTE — so let's use a plain external ref token
		const externalRef: import('../services/parse-service').TableRefToken = {
			type: 'table_ref', name: 'raw_orders', line: 10, col: 9, endCol: 18,
		};
		const chain = ParseService.traceCteLineage(externalRef, model);
		// raw_orders is not a ref() in this model and has no alias — returns the bare table name
		expect(chain).toEqual(['raw_orders']);
	});

	it('returns [ref(name)] for a direct ref() token with an alias', () => {
		// FROM {{ ref('gold__address') }} wh — the alias is the qualifier, not a chain step
		const directRef: import('../services/parse-service').TableRefToken = {
			type: 'table_ref', name: 'gold__address', alias: 'wh', line: 1, col: 5, endCol: 18,
		};
		// model has refs: [{ model: 'gold__address', line: 1 }]
		const chain = ParseService.traceCteLineage(directRef, model);
		expect(chain).toEqual(["ref('gold__address')"]);
	});

	it('follows a two-hop chain: cte_b → cte_a → ref', () => {
		// cte_a (line 0..2): SELECT * FROM ref('source')
		// cte_b (line 3..7): SELECT * FROM cte_a AS x
		const sourceRef: import('../services/parse-service').TableRefToken = {
			type: 'table_ref', name: 'source_table', line: 1, col: 5, endCol: 15,
		};
		const ctaARef: import('../services/parse-service').TableRefToken = {
			type: 'table_ref', name: 'cte_a', alias: 'x', line: 5, col: 9, endCol: 14,
		};
		const twoHopModel: DocumentModel = {
			ctes: [
				{ name: 'cte_a', line: 0, endLine: 2, columns: [{ name: '*', line: 1 }] },
				{ name: 'cte_b', line: 3, endLine: 7, columns: [{ name: 'col', line: 4 }] },
			],
			refs: [],
			sources: [],
			finalColumns: [],
			tokens: [sourceRef, ctaARef] as TokenInfo[],
			timing: { parseMs: 1, totalMs: 2 },
		};
		const cteBRef: import('../services/parse-service').TableRefToken = {
			type: 'table_ref', name: 'cte_b', line: 8, col: 14, endCol: 18,
		};
		const chain = ParseService.traceCteLineage(cteBRef, twoHopModel);
		expect(chain).toEqual(['cte_b', 'cte_a', 'source_table']);
	});
});
