import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { DbtReferenceProvider } from '../providers/sql/reference-provider';
import { DbtRenameProvider } from '../providers/sql/rename-provider';
import { SqlCodeLensProvider } from '../providers/sql/codelens-provider';
import { YamlDocumentSymbolProvider } from '../providers/yaml/document-symbol-provider';
import { DbtWorkspaceSymbolProvider } from '../providers/workspace-symbol-provider';
import { DbtSignatureHelpProvider } from '../providers/sql/signature-help-provider';
import { SqlCodeActionProvider } from '../ninja/code-actions/provider';
import { createMockLogger } from './helpers';
import { sym, colSym } from './ninja/helpers';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource, IndexedMacro } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { DbtPathResolver, DbtFileCategory } from '../dbt/dbt-path-resolver';
import type { ParseService, DocumentModel } from '../services/parse-service';
import type { Sym } from '../ftl/sqllens/api';

function createMockParseService(): ParseService {
	return {
		getDocumentModel: vi.fn().mockResolvedValue(null),
		getDialectSymbols: vi.fn().mockResolvedValue(undefined),
		completeAt: vi.fn().mockReturnValue([]),
		signatureAt: vi.fn().mockReturnValue(null),
	} as unknown as ParseService;
}

function createMockParseServiceWithModel(model: Partial<DocumentModel>): ParseService {
	const full: DocumentModel = {
		ctes: [],
		refs: [],
		sources: [],
		finalColumns: [],
		timing: { parseMs: 0, totalMs: 0 },
		...model,
	};
	return {
		getDocumentModel: vi.fn().mockResolvedValue(full),
		getDialectSymbols: vi.fn().mockResolvedValue(undefined),
		completeAt: vi.fn().mockReturnValue([]),
		signatureAt: vi.fn().mockReturnValue(null),
	} as unknown as ParseService;
}

function createMockPathResolver(mapping: Record<string, DbtFileCategory> = {}): DbtPathResolver {
	return {
		classifyFile: (filePath: string) => mapping[filePath] ?? 'unknown',
	} as unknown as DbtPathResolver;
}

// --------------- Helpers ---------------

function createMockIndexer(overrides?: Partial<ManifestIndex>): ManifestIndexer {
	const models = new Map<string, IndexedModel>();
	models.set('model.project.customers', {
		uniqueId: 'model.project.customers',
		name: 'customers',
		packageName: 'project',
		path: '/project/models/customers.sql',
		schema: 'main',
		materialisation: 'table',
		tags: ['daily'],
		description: 'Customers model',
	});
	models.set('model.project.orders', {
		uniqueId: 'model.project.orders',
		name: 'orders',
		packageName: 'project',
		path: '/project/models/orders.sql',
		schema: 'main',
		materialisation: 'view',
		tags: [],
	});

	const sources = new Map<string, IndexedSource>();
	sources.set('source.project.raw.payments', {
		uniqueId: 'source.project.raw.payments',
		name: 'payments',
		sourceName: 'raw',
		schema: 'raw_data',
		tags: [],
		description: 'Raw payments',
	});

	const macros = new Map<string, IndexedMacro>();
	macros.set('macro.project.my_macro', {
		uniqueId: 'macro.project.my_macro',
		name: 'my_macro',
		packageName: 'project',
		description: 'A custom macro',
		arguments: [
			{ name: 'column_name', type: 'string', description: 'The column' },
			{ name: 'default_val', type: 'string', description: 'Default value' },
		],
	});

	const index: ManifestIndex = {
		models: overrides?.models ?? models,
		sources: overrides?.sources ?? sources,
		macros: overrides?.macros ?? macros,
		functions: overrides?.functions ?? new Map(),
		nodesByName: overrides?.nodesByName ?? new Map([
			['customers', ['model.project.customers']],
			['orders', ['model.project.orders']],
		]),
		parentMap: overrides?.parentMap ?? new Map([
			['model.project.orders', ['model.project.customers', 'source.project.raw.payments']],
		]),
		childMap: overrides?.childMap ?? new Map([
			['model.project.customers', ['model.project.orders']],
			['source.project.raw.payments', ['model.project.orders']],
		]),
		dbtVersion: '1.8.0',
		adapterType: 'duckdb',
		buildTime: new Date(),
	};

	return {
		index,
		findModelsByName: vi.fn((name: string) => {
			const results: IndexedModel[] = [];
			for (const m of index.models.values()) {
				if (m.name === name) results.push(m);
			}
			return results;
		}),
		findResource: vi.fn(),
		getRawNode: vi.fn(),
		getLineage: vi.fn(),
		findMacrosByPrefix: vi.fn(),
		findMacroByName: vi.fn((name: string) => {
			for (const macro of index.macros.values()) {
				if (macro.name === name) return macro;
			}
			return undefined;
		}),
		findSourceByKey: vi.fn((sourceName: string, tableName: string) => {
			for (const [uid, src] of index.sources) {
				if (src.sourceName === sourceName && src.name === tableName) {
					return { uid, source: src };
				}
			}
			return undefined;
		}),
		findByTag: vi.fn(),
		findModelByFilePath: vi.fn(),
		build: vi.fn(),
	} as unknown as ManifestIndexer;
}

function createMockLoader(): ManifestLoader {
	return {
		projectDir: '/project',
	} as unknown as ManifestLoader;
}

function createMockDocument(content: string, options?: {
	languageId?: string;
	fileName?: string;
}): vscode.TextDocument {
	const lines = content.split('\n');
	return {
		languageId: options?.languageId ?? 'jinja-sql',
		fileName: options?.fileName ?? '/project/models/customers.sql',
		getText: vi.fn(() => content),
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
		offsetAt: vi.fn((position: vscode.Position) => {
			let offset = 0;
			for (let i = 0; i < position.line; i++) {
				offset += (lines[i] ?? '').length + 1;
			}
			return offset + position.character;
		}),
		lineCount: lines.length,
		uri: vscode.Uri.file(options?.fileName ?? '/project/models/customers.sql'),
	} as unknown as vscode.TextDocument;
}

const mockToken: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: vi.fn(),
};

/**
 * `sym()`/`colSym()` (`./ninja/helpers`) derive `Span.start`/`.end` (and, for `colSym`,
 * each `PartSpan.start`/`.end`) from `column`/`endColumn` alone — correct only for a
 * fixture on line 0, where the raw column IS the absolute char offset. `ParseService.
 * symAtPosition`/`partIndexAtPosition` hit-test the REAL absolute offset into the
 * document (`span.start <= offset < span.end`), so any fixture below whose symbol
 * doesn't sit on line 0 needs `start`/`end` recomputed from ITS OWN fixture text before
 * that comparison means anything. `lineStartsOf` is the same prefix-sum
 * `createMockDocument`'s own `offsetAt`/`positionAt` use, so a `Sym` corrected against it
 * lands on the exact offset the mock document reports for the symbol's `line`/`column`.
 */
function lineStartsOf(text: string): number[] {
	const lines = text.split('\n');
	const starts: number[] = [0];
	for (let i = 0; i < lines.length - 1; i++) starts.push(starts[i] + lines[i].length + 1);
	return starts;
}

/** Recompute a `sym()`/`colSym()` fixture's `start`/`end` (top-level span, and any
 *  `partSpans`) as true absolute offsets into `lineStarts`'s source text. */
function withOffsets(s: Sym, lineStarts: number[]): Sym {
	const fix = (span: { line: number; column: number; endLine: number; endColumn: number }) => ({
		start: lineStarts[span.line - 1] + span.column,
		end: lineStarts[span.endLine - 1] + span.endColumn,
	});
	return {
		...s,
		span: { ...s.span, ...fix(s.span) },
		...(s.partSpans ? { partSpans: s.partSpans.map(p => ({ ...p, ...fix(p) })) } : {}),
	};
}

// --------------- ReferenceProvider ---------------

describe('DbtReferenceProvider', () => {
	let provider: DbtReferenceProvider;
	let indexer: ManifestIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = createMockIndexer();
		provider = new DbtReferenceProvider(indexer, createMockLogger(), createMockParseService());
	});

	it('returns empty array when cursor is not on a ref or source', async () => {
		const doc = createMockDocument('select * from orders');
		const pos = new vscode.Position(0, 5);
		const result = await provider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);
		expect(result).toEqual([]);
	});

	it('finds ref usages via manifest childMap', async () => {
		const doc = createMockDocument('select * from {{ ref(\'customers\') }}');
		const pos = new vscode.Position(0, 25); // cursor on 'customers'

		// Mock the downstream file content (orders.sql depends on customers)
		const matchDoc = createMockDocument('select * from {{ ref(\'customers\') }}', { fileName: '/project/models/orders.sql' });
		vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(matchDoc);

		const result = await provider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);

		// Should include the model definition + downstream ref in orders.sql
		expect(result.length).toBe(2);
		expect(result[0].uri.fsPath).toContain('customers.sql');
		expect(result[1].uri.fsPath).toContain('orders.sql');
	});

	it('finds source usages via manifest childMap', async () => {
		const doc = createMockDocument('select * from {{ source(\'raw\', \'payments\') }}');
		const pos = new vscode.Position(0, 30);

		// orders.sql depends on source.project.raw.payments per childMap
		const matchDoc = createMockDocument('select * from {{ source(\'raw\', \'payments\') }}', { fileName: '/project/models/orders.sql' });
		vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(matchDoc);

		const result = await provider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);
		expect(result.length).toBe(1);
		expect(result[0].uri.fsPath).toContain('orders.sql');
	});

	it('finds CTE name references via symbol stream', async () => {
		// SQL: with base as (...), final as (select * from base) select * from final
		// Syms: 'base' reference at line 1 col 26 (used inside final's body)
		const baseCte = { name: 'base', line: 0, col: 5, endLine: 0, endCol: 20, columns: [] };
		const finalCte = { name: 'final', line: 1, col: 5, endLine: 1, endCol: 50, columns: [] };
		const text = 'with base as (select 1 id),\n     final as (select * from base)\nselect * from final';
		const ls = lineStartsOf(text);
		const mockModel: Partial<DocumentModel> = {
			ctes: [baseCte, finalCte],
			symbols: [
				withOffsets(sym('cte', 'base', 1, 26, { definitionOf: baseCte }), ls),
				withOffsets(sym('cte', 'final', 2, 14, { definitionOf: finalCte }), ls),
			],
			refs: [],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtReferenceProvider(indexer, createMockLogger(), ps);
		const doc = createMockDocument(text);
		// Cursor on the 'base' table_ref token on line 1 col 28 (inside [26,30))
		const pos = new vscode.Position(1, 28);
		const result = await localProvider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);

		// Definition at (line 0, col 5) + usage at (line 1, col 26)
		expect(result).toHaveLength(2);
		const lines = result.map(l => l.range.start.line);
		expect(lines).toContain(0); // definition
		expect(lines).toContain(1); // usage
	});

	it('finds CTE name references when the folded CteInfo name disagrees with the declared Sym name (regression)', async () => {
		// Regression coverage for a real bug: Sym.name for a CTE is sqllens's displayName
		// (the declared spelling, "MyCte"); CteInfo.name (extractCtes) folds through
		// normName for dialect casing — e.g. Snowflake uppercases unquoted identifiers to
		// "MYCTE". A name-string comparison between the two silently fails; the provider
		// must match by structural anchor (symMatchesCte) instead.
		const myCte = { name: 'MYCTE', line: 0, col: 5, endLine: 0, endCol: 20, columns: [] };
		const text = 'with MyCte as (select 1 id)\nselect * from MyCte';
		const ls = lineStartsOf(text);
		const mockModel: Partial<DocumentModel> = {
			ctes: [myCte],
			symbols: [
				withOffsets(sym('cte', 'MyCte', 0, 5, { modifiers: ['declaration'] }), ls),
				withOffsets(sym('cte', 'MyCte', 1, 14, { definitionOf: myCte }), ls),
			],
			refs: [],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtReferenceProvider(indexer, createMockLogger(), ps);
		const doc = createMockDocument(text);
		const pos = new vscode.Position(1, 16); // cursor on the 'MyCte' reference
		const result = await localProvider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);

		expect(result).toHaveLength(2);
		const lines = result.map(l => l.range.start.line);
		expect(lines).toContain(0); // definition
		expect(lines).toContain(1); // usage
	});

	it('finds table alias references and its column qualifiers', async () => {
		// FROM orders o  →  o.id, o.amount
		const text = 'select o.id, o.amount\nfrom orders o';
		const ls = lineStartsOf(text);
		const ordersRelation = withOffsets(sym('table', 'orders', 1, 5, { alias: { name: 'o', line: 1, col: 12 } }), ls);
		const ordersAlias = withOffsets(sym('alias', 'o', 1, 12, { modifiers: ['declaration'] }), ls);
		const idCol = withOffsets(colSym(0, [{ name: 'o', col: 5 }, { name: 'id', col: 7 }], { source: ordersRelation }), ls);
		const amountCol = withOffsets(colSym(0, [{ name: 'o', col: 13 }, { name: 'amount', col: 15 }], { source: ordersRelation }), ls);
		const mockModel: Partial<DocumentModel> = {
			ctes: [],
			refs: [],
			symbols: [ordersRelation, ordersAlias, idCol, amountCol],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtReferenceProvider(indexer, createMockLogger(), ps);
		const doc = createMockDocument(text);
		// Cursor on the alias definition 'o' at line 1 col 12
		const pos = new vscode.Position(1, 12);
		const result = await localProvider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);

		// alias definition + 2 qualifier occurrences
		expect(result).toHaveLength(3);
		const [def, ...uses] = result;
		expect(def.range.start.line).toBe(1);
		expect(def.range.start.character).toBe(12);
		expect(uses.every(u => u.range.start.line === 0)).toBe(true);
	});

	it('finds alias references when cursor is on a qualifier (o.col)', async () => {
		const text = 'select o.id\nfrom orders o';
		const ls = lineStartsOf(text);
		const ordersRelation = withOffsets(sym('table', 'orders', 1, 5, { alias: { name: 'o', line: 1, col: 12 } }), ls);
		const ordersAlias = withOffsets(sym('alias', 'o', 1, 12, { modifiers: ['declaration'] }), ls);
		const idCol = withOffsets(colSym(0, [{ name: 'o', col: 5 }, { name: 'id', col: 7 }], { source: ordersRelation }), ls);
		const mockModel: Partial<DocumentModel> = {
			ctes: [],
			refs: [],
			symbols: [ordersRelation, ordersAlias, idCol],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtReferenceProvider(indexer, createMockLogger(), ps);
		const doc = createMockDocument(text);
		// Cursor on the qualifier 'o' in 'o.id' — tableCol=5, tableEndCol=6, so col 5
		const pos = new vscode.Position(0, 5);
		const result = await localProvider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);

		// alias definition + 1 qualifier occurrence
		expect(result).toHaveLength(2);
	});
});

// --------------- RenameProvider ---------------

describe('DbtRenameProvider', () => {
	let provider: DbtRenameProvider;
	let indexer: ManifestIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = createMockIndexer();
		provider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger());
	});

	it('prepareRename returns range and placeholder for ref()', async () => {
		const doc = createMockDocument('select * from {{ ref(\'customers\') }}');
		const pos = new vscode.Position(0, 26); // cursor on 'customers'

		const result = await provider.prepareRename(doc, pos, mockToken);
		expect(result).toBeDefined();
		expect((result as { placeholder: string }).placeholder).toBe('customers');
	});

	it('prepareRename rejects for non-ref positions (no parseService)', async () => {
		const doc = createMockDocument('select * from orders');
		const pos = new vscode.Position(0, 5);

		await expect(provider.prepareRename(doc, pos, mockToken)).rejects.toThrow();
	});

	it('provideRenameEdits creates workspace edit for ref rename', async () => {
		const doc = createMockDocument('select * from {{ ref(\'customers\') }}');
		const pos = new vscode.Position(0, 26);

		// downstream file (orders.sql) contains ref('customers')
		const matchDoc = createMockDocument('select * from {{ ref(\'customers\') }}', { fileName: '/project/models/orders.sql' });
		vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue(matchDoc);

		const result = await provider.provideRenameEdits(doc, pos, 'clients', mockToken);
		expect(result).toBeInstanceOf(vscode.WorkspaceEdit);
	});

	it('provideRenameEdits returns undefined when cursor not on ref (no parseService)', async () => {
		const doc = createMockDocument('select * from orders');
		const pos = new vscode.Position(0, 5);

		const result = await provider.provideRenameEdits(doc, pos, 'new_name', mockToken);
		expect(result).toBeUndefined();
	});

	it('prepareRename returns column range for a column reference sym', async () => {
		const mockModel: Partial<DocumentModel> = {
			symbols: [colSym(0, [{ name: 'order_id', col: 7 }])],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('select order_id from orders');
		const pos = new vscode.Position(0, 10); // inside 'order_id' [7,15)

		const result = await localProvider.prepareRename(doc, pos, mockToken) as { range: vscode.Range; placeholder: string };
		expect(result.placeholder).toBe('order_id');
		expect(result.range.start.character).toBe(7);
		expect(result.range.end.character).toBe(15);
	});

	it('prepareRename returns alias range for an alias sym', async () => {
		const text = 'select o.id\nfrom orders o';
		const ls = lineStartsOf(text);
		const mockModel: Partial<DocumentModel> = {
			symbols: [
				withOffsets(sym('table', 'orders', 1, 5), ls),
				withOffsets(sym('alias', 'o', 1, 12, { modifiers: ['declaration'] }), ls),
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument(text);
		const pos = new vscode.Position(1, 12); // cursor on alias 'o'

		const result = await localProvider.prepareRename(doc, pos, mockToken) as { range: vscode.Range; placeholder: string };
		expect(result.placeholder).toBe('o');
		expect(result.range.start.character).toBe(12);
	});

	it('prepareRename returns alias range for a column qualifier part', async () => {
		const text = 'select o.id\nfrom orders o';
		const ls = lineStartsOf(text);
		const ordersRelation = withOffsets(sym('table', 'orders', 1, 5, { alias: { name: 'o', line: 1, col: 12 } }), ls);
		const ordersAlias = withOffsets(sym('alias', 'o', 1, 12, { modifiers: ['declaration'] }), ls);
		const idCol = withOffsets(colSym(0, [{ name: 'o', col: 7 }, { name: 'id', col: 9 }], { source: ordersRelation }), ls);
		const mockModel: Partial<DocumentModel> = {
			symbols: [ordersRelation, ordersAlias, idCol],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument(text);
		const pos = new vscode.Position(0, 7); // cursor on qualifier 'o' in 'o.id'

		const result = await localProvider.prepareRename(doc, pos, mockToken) as { range: vscode.Range; placeholder: string };
		expect(result.placeholder).toBe('o');
	});

	it('prepareRename returns CTE name range for a cte reference sym', async () => {
		const baseCte = { name: 'base', line: 0, col: 5, endLine: 0, endCol: 9, columns: [] };
		const text = 'with base as (select 1),\nselect * from base';
		const ls = lineStartsOf(text);
		const mockModel: Partial<DocumentModel> = {
			ctes: [baseCte],
			symbols: [withOffsets(sym('cte', 'base', 1, 14, { definitionOf: baseCte }), ls)],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument(text);
		const pos = new vscode.Position(1, 16); // cursor on 'base' table_ref

		const result = await localProvider.prepareRename(doc, pos, mockToken) as { range: vscode.Range; placeholder: string };
		expect(result.placeholder).toBe('base');
	});

	it('provideRenameEdits renames all column occurrences in-file', async () => {
		const mockModel: Partial<DocumentModel> = {
			symbols: [
				colSym(0, [{ name: 'order_id', col: 7 }], { modifiers: ['declaration', 'output'] }),
				colSym(1, [{ name: 'order_id', col: 4 }]),
				colSym(2, [{ name: 'order_id', col: 0 }]),
				colSym(1, [{ name: 'amount', col: 14 }]),
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('select order_id,\n    order_id, amount\norder_id');
		const pos = new vscode.Position(0, 10); // cursor on column_def

		const result = await localProvider.provideRenameEdits(doc, pos, 'oid', mockToken);
		expect(result).toBeInstanceOf(vscode.WorkspaceEdit);
		// 3 replacements: column_def + 2 column_ref for 'order_id'
		const entries = result!.entries();
		const totalEdits = entries.reduce((s, [, edits]) => s + edits.length, 0);
		expect(totalEdits).toBe(3);
	});

	it('provideRenameEdits renames alias definition and all qualifier spans', async () => {
		const text = 'select o.id, o.amount\nfrom orders o';
		const ls = lineStartsOf(text);
		const ordersRelation = withOffsets(sym('table', 'orders', 1, 5, { alias: { name: 'o', line: 1, col: 12 } }), ls);
		const ordersAlias = withOffsets(sym('alias', 'o', 1, 12, { modifiers: ['declaration'] }), ls);
		const idCol = withOffsets(colSym(0, [{ name: 'o', col: 7 }, { name: 'id', col: 9 }], { source: ordersRelation }), ls);
		const amountCol = withOffsets(colSym(0, [{ name: 'o', col: 12 }, { name: 'amount', col: 14 }], { source: ordersRelation }), ls);
		const mockModel: Partial<DocumentModel> = {
			symbols: [ordersRelation, ordersAlias, idCol, amountCol],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument(text);
		const pos = new vscode.Position(1, 12); // cursor on alias 'o'

		const result = await localProvider.provideRenameEdits(doc, pos, 'ord', mockToken);
		expect(result).toBeInstanceOf(vscode.WorkspaceEdit);
		const entries = result!.entries();
		const totalEdits = entries.reduce((s, [, edits]) => s + edits.length, 0);
		// alias site + 2 qualifier spans = 3
		expect(totalEdits).toBe(3);
	});

	it('provideRenameEdits renames CTE name definition and all usages', async () => {
		// endLine/endCol represent the closing paren of the CTE body — on a
		// different line from the name. The rename must NOT use endCol as the name
		// end (Bug #2 regression guard).
		const text = 'with base as (\n  select 1\n),\nselect * from base';
		const ls = lineStartsOf(text);
		const baseCteDecl = withOffsets(sym('cte', 'base', 0, 5, { modifiers: ['declaration'] }), ls);
		const mockModel: Partial<DocumentModel> = {
			ctes: [{ name: 'base', line: 0, col: 5, endLine: 2, endCol: 1, columns: [] }],
			symbols: [
				baseCteDecl, // cte declaration
				withOffsets(sym('cte', 'base', 3, 14, { definitionOf: baseCteDecl }), ls), // usage in FROM
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument(text);
		const pos = new vscode.Position(3, 16); // cursor on usage 'base'

		const result = await localProvider.provideRenameEdits(doc, pos, 'foundation', mockToken);
		expect(result).toBeInstanceOf(vscode.WorkspaceEdit);
		const entries = result!.entries();
		const totalEdits = entries.reduce((s, [, edits]) => s + edits.length, 0);
		// def-site token + usage token — no separate cteDef edit
		expect(totalEdits).toBe(2);
	});

	it('provideRenameEdits renames CTE from the definition site', async () => {
		const baseCteDecl = sym('cte', 'base', 0, 5, { modifiers: ['declaration'] });
		const mockModel: Partial<DocumentModel> = {
			ctes: [{ name: 'base', line: 0, col: 5, endLine: 2, endCol: 1, columns: [] }],
			symbols: [
				baseCteDecl, // cte declaration
				sym('cte', 'base', 3, 14, { definitionOf: baseCteDecl }), // usage in FROM
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('with base as (\n  select 1\n),\nselect * from base');
		const pos = new vscode.Position(0, 6); // cursor on 'base' in the definition line

		const result = await localProvider.provideRenameEdits(doc, pos, 'foundation', mockToken);
		expect(result).toBeInstanceOf(vscode.WorkspaceEdit);
		const entries = result!.entries();
		const totalEdits = entries.reduce((s, [, edits]) => s + edits.length, 0);
		// def-site token + usage token
		expect(totalEdits).toBe(2);
	});
});

// --------------- CodeLensProvider ---------------

describe('SqlCodeLensProvider', () => {
	let provider: SqlCodeLensProvider;
	let indexer: ManifestIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = createMockIndexer();
		provider = new SqlCodeLensProvider(indexer, createMockLogger(), createMockParseService());
		provider.setPathResolver(createMockPathResolver({
			'/project/models/customers.sql': 'model',
			'/project/models/orders.sql': 'model',
		}));
	});

	it('does not add model action lenses for known SQL model', async () => {
		const doc = createMockDocument('{{ config(materialized=\'table\') }}\nselect 1', {
			fileName: '/project/models/customers.sql',
		});

		const result = await provider.provideCodeLenses(doc, mockToken);
		expect(result.length).toBe(0);
	});

	it('adds CTE query lenses when parse service returns CTEs', async () => {
		const parseService = createMockParseServiceWithModel({
			ctes: [
				{ name: 'base', line: 2, endLine: 5, columns: [] },
				{ name: 'final', line: 7, endLine: 10, columns: [] },
			],
		});
		provider = new SqlCodeLensProvider(indexer, createMockLogger(), parseService);
		provider.setPathResolver(createMockPathResolver({ '/project/models/customers.sql': 'model' }));
		vi.mocked(indexer.findModelByFilePath).mockReturnValue('model.project.customers');

		const doc = createMockDocument('WITH base AS (\n  SELECT 1\n)\nSELECT * FROM base', {
			fileName: '/project/models/customers.sql',
		});

		const result = await provider.provideCodeLenses(doc, mockToken);
		const cteLenses = result.filter(l => l.command?.command === 'dbt-anvil.queryCte');
		expect(cteLenses).toHaveLength(2);
		expect(cteLenses[0].command?.arguments).toEqual(['model.project.customers', 'base']);
		expect(cteLenses[1].command?.arguments).toEqual(['model.project.customers', 'final']);
		expect(cteLenses[0].range.start.line).toBe(2);
		expect(cteLenses[1].range.start.line).toBe(7);
	});

	it('shows ad-hoc Run lenses for unknown model', async () => {
		const doc = createMockDocument('SELECT 1;\nSELECT 2', {
			fileName: '/project/analyses/scratch.sql',
		});

		const result = await provider.provideCodeLenses(doc, mockToken);
		const titles = result.map(l => l.command?.title);
		expect(titles.filter(t => t === 'Press F5 to run')).toHaveLength(2);
	});

	it('shows single Run lens for unknown model with one statement', async () => {
		const doc = createMockDocument('SELECT 1', {
			fileName: '/project/analyses/scratch.sql',
		});

		const result = await provider.provideCodeLenses(doc, mockToken);
		expect(result).toHaveLength(1);
		expect(result[0].command?.title).toBe('Press F5 to run');
	});

	it('fires onDidChangeCodeLenses when refresh() is called', () => {
		const listener = vi.fn();
		provider.onDidChangeCodeLenses(listener);
		provider.refresh();
		expect(listener).toHaveBeenCalled();
	});
});

// --------------- DocumentSymbolProvider ---------------

describe('YamlDocumentSymbolProvider', () => {
	let provider: YamlDocumentSymbolProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new YamlDocumentSymbolProvider(createMockLogger());
	});

	it('extracts model/column hierarchy from YAML', () => {
		const yaml = [
			'version: 2',
			'models:',
			'  - name: customers',
			'    columns:',
			'      - name: id',
			'      - name: email',
		].join('\n');

		const doc = createMockDocument(yaml, {
			languageId: 'yaml',
			fileName: '/project/models/schema.yml',
		});
		const symbols = provider.provideDocumentSymbols(doc, mockToken) as vscode.DocumentSymbol[];

		expect(symbols.length).toBe(1);
		expect(symbols[0].name).toBe('customers');
		expect(symbols[0].children.length).toBe(2);
		expect(symbols[0].children[0].name).toBe('id');
		expect(symbols[0].children[1].name).toBe('email');
	});
});

// --------------- WorkspaceSymbolProvider ---------------

describe('DbtWorkspaceSymbolProvider', () => {
	let provider: DbtWorkspaceSymbolProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new DbtWorkspaceSymbolProvider(createMockIndexer(), createMockLogger());
	});

	it('returns models matching query', () => {
		const results = provider.provideWorkspaceSymbols('cust', mockToken);
		const names = results.map(r => r.name);
		expect(names).toContain('customers');
		expect(names).not.toContain('orders');
	});

	it('returns sources matching query', () => {
		const results = provider.provideWorkspaceSymbols('payment', mockToken);
		const names = results.map(r => r.name);
		expect(names).toContain('raw.payments');
	});

	it('returns macros matching query', () => {
		const results = provider.provideWorkspaceSymbols('my_macro', mockToken);
		const names = results.map(r => r.name);
		expect(names).toContain('my_macro');
	});

	it('returns all symbols for empty query', () => {
		const results = provider.provideWorkspaceSymbols('', mockToken);
		// Should include all models, sources, macros
		expect(results.length).toBe(4); // 2 models + 1 source + 1 macro
	});

	it('returns empty when index is null', () => {
		const indexer = createMockIndexer();
		(indexer as unknown as { index: null }).index = null;
		const p = new DbtWorkspaceSymbolProvider(indexer, createMockLogger());
		const results = p.provideWorkspaceSymbols('test', mockToken);
		expect(results).toEqual([]);
	});
});

// --------------- SignatureHelpProvider ---------------

describe('DbtSignatureHelpProvider', () => {
	let provider: DbtSignatureHelpProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new DbtSignatureHelpProvider(createMockIndexer(), createMockLogger(), createMockParseService());
	});

	it('shows parameter hints for known macro', () => {
		const doc = createMockDocument('{{ my_macro(');
		const pos = new vscode.Position(0, 12);
		const ctx = {} as vscode.SignatureHelpContext;

		const result = provider.provideSignatureHelp(doc, pos, mockToken, ctx);
		expect(result).toBeDefined();
		expect(result!.signatures.length).toBe(1);
		expect(result!.signatures[0].parameters.length).toBe(2);
		expect(result!.signatures[0].parameters[0].label).toBe('column_name');
		expect(result!.signatures[0].parameters[1].label).toBe('default_val');
		expect(result!.activeParameter).toBe(0);
	});

	it('tracks active parameter via comma count', () => {
		const doc = createMockDocument('{{ my_macro(\'val1\', ');
		const pos = new vscode.Position(0, 20);
		const ctx = {} as vscode.SignatureHelpContext;

		const result = provider.provideSignatureHelp(doc, pos, mockToken, ctx);
		expect(result).toBeDefined();
		expect(result!.activeParameter).toBe(1);
	});

	it('returns undefined for built-in functions', () => {
		const doc = createMockDocument('{{ ref(\'');
		const pos = new vscode.Position(0, 8);
		const ctx = {} as vscode.SignatureHelpContext;

		const result = provider.provideSignatureHelp(doc, pos, mockToken, ctx);
		expect(result).toBeUndefined();
	});

	it('returns undefined when not inside a macro call', () => {
		const doc = createMockDocument('select * from orders');
		const pos = new vscode.Position(0, 10);
		const ctx = {} as vscode.SignatureHelpContext;

		const result = provider.provideSignatureHelp(doc, pos, mockToken, ctx);
		expect(result).toBeUndefined();
	});

	it('returns undefined for macro with no arguments', () => {
		const indexer = createMockIndexer();
		indexer.index!.macros.set('macro.project.no_args', {
			uniqueId: 'macro.project.no_args',
			name: 'no_args',
			packageName: 'project',
			arguments: [],
		});
		const p = new DbtSignatureHelpProvider(indexer, createMockLogger(), createMockParseService());

		const doc = createMockDocument('{{ no_args(');
		const pos = new vscode.Position(0, 11);
		const ctx = {} as vscode.SignatureHelpContext;

		const result = p.provideSignatureHelp(doc, pos, mockToken, ctx);
		expect(result).toBeUndefined();
	});

	it('shows a SQL function signature from sqllens when not in a macro call', () => {
		const ps = {
			getDocumentModel: vi.fn().mockResolvedValue(null),
			getDialectSymbols: vi.fn().mockResolvedValue(undefined),
			completeAt: vi.fn().mockReturnValue([]),
			signatureAt: vi.fn().mockReturnValue({
				signatures: [{
					label: 'date_add(start_date: date, num_days: int)',
					parameters: [{ label: 'start_date: date' }, { label: 'num_days: int' }],
				}],
				activeSignature: 0,
				activeParameter: 1,
			}),
		} as unknown as ParseService;
		const p = new DbtSignatureHelpProvider(createMockIndexer(), createMockLogger(), ps);

		const doc = createMockDocument('select date_add(order_date, 1) from t');
		const pos = new vscode.Position(0, 28); // inside the 2nd argument
		const ctx = {} as vscode.SignatureHelpContext;

		const result = p.provideSignatureHelp(doc, pos, mockToken, ctx);
		expect(result).toBeDefined();
		expect(result!.signatures[0].label).toContain('date_add');
		expect(result!.signatures[0].parameters.length).toBe(2);
		expect(result!.activeParameter).toBe(1);
	});
});

// --------------- CodeActionProvider ---------------

describe('SqlCodeActionProvider', () => {
	let provider: SqlCodeActionProvider;
	let indexer: ManifestIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = createMockIndexer();
		provider = new SqlCodeActionProvider(indexer, createMockLogger());
	});

	it('offers to create missing model file', () => {
		const doc = createMockDocument('select * from {{ ref(\'nonexistent_model\') }}');
		const range = new vscode.Range(0, 0, 0, 44);
		const ctx = { diagnostics: [] } as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		const quickFix = actions.find(a => a.kind?.value === vscode.CodeActionKind.QuickFix.value);
		expect(quickFix).toBeDefined();
		expect(quickFix!.title).toContain('nonexistent_model');
		expect(quickFix!.command?.command).toBe('dbt-anvil.createModelFile');
		expect(quickFix!.isPreferred).toBe(true);
	});

	it('returns no QuickFix actions for existing model refs', () => {
		const doc = createMockDocument('select * from {{ ref(\'customers\') }}');
		const range = new vscode.Range(0, 0, 0, 36);
		const ctx = { diagnostics: [] } as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		const quickFixes = actions.filter(a => a.kind === vscode.CodeActionKind.QuickFix);
		expect(quickFixes).toEqual([]);
	});

	it('has QuickFix as provided code action kind', () => {
		expect(SqlCodeActionProvider.providedCodeActionKinds).toContain(vscode.CodeActionKind.QuickFix);
	});

	// Rule-engine actions: a ninja diagnostic must always be configurable, even
	// when the rule has no fix to offer.
	function ninjaDiagnostic(ruleId: string, line = 0): vscode.Diagnostic {
		const diag = new vscode.Diagnostic(new vscode.Range(line, 0, line, 5), 'nope');
		diag.source = 'ninja';
		diag.code = ruleId;
		return diag;
	}

	it('offers suppress / disable / configure for a ninja diagnostic with no fix', () => {
		const doc = createMockDocument('select * from customers');
		const range = new vscode.Range(0, 0, 0, 5);
		const ctx = {
			diagnostics: [ninjaDiagnostic('ninja.aliasing.require-table-alias')],
		} as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		const titles = actions.map(a => a.title);
		expect(titles).toEqual([
			'Suppress ninja.aliasing.require-table-alias on this line',
			'Disable ninja.aliasing.require-table-alias in this workspace',
			'Configure ninja.aliasing.require-table-alias...',
		]);

		const suppress = actions[0];
		expect(suppress.edit!.entries()[0][1][0]).toMatchObject({
			newText: ' -- noqa: ninja.aliasing.require-table-alias',
		});
		expect(actions[1].command?.command).toBe('dbt-anvil.ninja.disableRule');
		expect(actions[1].command?.arguments).toEqual(['ninja.aliasing.require-table-alias']);
		expect(actions[2].command?.command).toBe('dbt-anvil.ninja.configureRule');
	});

	it('offers the rule actions once per rule, not once per diagnostic', () => {
		const doc = createMockDocument('select a, b from customers');
		const range = new vscode.Range(0, 0, 0, 26);
		const ctx = {
			diagnostics: [ninjaDiagnostic('ninja.cap.keywords'), ninjaDiagnostic('ninja.cap.keywords')],
		} as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		expect(actions.filter(a => a.title.startsWith('Disable '))).toHaveLength(1);
	});

	it('ignores diagnostics from other sources', () => {
		const doc = createMockDocument('select * from customers');
		const range = new vscode.Range(0, 0, 0, 5);
		const other = new vscode.Diagnostic(new vscode.Range(0, 0, 0, 5), 'unknown ref');
		other.source = 'dbt';
		other.code = 'unknown-ref';
		const ctx = { diagnostics: [other] } as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		expect(actions.filter(a => a.title.startsWith('Disable '))).toHaveLength(0);
	});

	it('omits the suppress action when the line already suppresses the rule', () => {
		const doc = createMockDocument('select * from customers -- noqa: ninja.cap.keywords');
		const range = new vscode.Range(0, 0, 0, 5);
		const ctx = {
			diagnostics: [ninjaDiagnostic('ninja.cap.keywords')],
		} as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		expect(actions.map(a => a.title)).toEqual([
			'Disable ninja.cap.keywords in this workspace',
			'Configure ninja.cap.keywords...',
		]);
	});
});
