import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { DbtReferenceProvider } from '../providers/sql/reference-provider';
import { DbtRenameProvider } from '../providers/sql/rename-provider';
import { SqlCodeLensProvider } from '../providers/sql/codelens-provider';
import { YamlDocumentSymbolProvider } from '../providers/yaml/document-symbol-provider';
import { DbtWorkspaceSymbolProvider } from '../providers/workspace-symbol-provider';
import { DbtSignatureHelpProvider } from '../providers/sql/signature-help-provider';
import { SqlCodeActionProvider } from '../providers/sql/code-action-provider';
import { createMockLogger } from './helpers';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource, IndexedMacro } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { DbtPathResolver, DbtFileCategory } from '../dbt/dbt-path-resolver';
import type { ParseService, DocumentModel } from '../services/parse-service';

function createMockParseService(): ParseService {
	return { getDocumentModel: vi.fn().mockResolvedValue(null) } as unknown as ParseService;
}

function createMockParseServiceWithModel(model: Partial<DocumentModel>): ParseService {
	const full: DocumentModel = {
		ctes: [],
		refs: [],
		sources: [],
		finalColumns: [],
		tokens: [],
		timing: { parseMs: 0, totalMs: 0 },
		...model,
	};
	return { getDocumentModel: vi.fn().mockResolvedValue(full) } as unknown as ParseService;
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
		lineCount: lines.length,
		uri: vscode.Uri.file(options?.fileName ?? '/project/models/customers.sql'),
	} as unknown as vscode.TextDocument;
}

const mockToken: vscode.CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: vi.fn(),
};

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

	it('finds CTE name references via token map', async () => {
		// SQL: with base as (...), final as (select * from base) select * from final
		// Tokens: table_ref 'base' at line 0 col 5 (CTE def), table_ref 'base' at line 1 col 26 (usage)
		const mockModel: Partial<DocumentModel> = {
			ctes: [
				{ name: 'base', line: 0, col: 5, endLine: 0, endCol: 20, columns: [] },
				{ name: 'final', line: 1, col: 5, endLine: 1, endCol: 50, columns: [] },
			],
			tokens: [
				{ type: 'table_ref', name: 'base', line: 1, col: 26, endCol: 30 },
				{ type: 'table_ref', name: 'final', line: 2, col: 14, endCol: 19 },
			],
			refs: [],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtReferenceProvider(indexer, createMockLogger(), ps);
		const doc = createMockDocument(
			'with base as (select 1 id),\n     final as (select * from base)\nselect * from final',
		);
		// Cursor on the 'base' table_ref token on line 1 col 28 (inside [26,30))
		const pos = new vscode.Position(1, 28);
		const result = await localProvider.provideReferences(doc, pos, { includeDeclaration: true }, mockToken);

		// Definition at (line 0, col 5) + usage at (line 1, col 26)
		expect(result).toHaveLength(2);
		const lines = result.map(l => l.range.start.line);
		expect(lines).toContain(0); // definition
		expect(lines).toContain(1); // usage
	});

	it('finds table alias references and its column qualifiers', async () => {
		// FROM orders o  →  o.id, o.amount
		const mockModel: Partial<DocumentModel> = {
			ctes: [],
			refs: [],
			tokens: [
				{
					type: 'table_ref',
					name: 'orders',
					line: 1, col: 5, endCol: 11,
					alias: 'o',
					aliasLine: 1, aliasCol: 12, aliasEndCol: 13,
				},
				{ type: 'column_ref', name: 'id',     line: 0, col: 7,  endCol: 9,  table: 'o', tableLine: 0, tableCol: 5, tableEndCol: 6 },
				{ type: 'column_ref', name: 'amount', line: 0, col: 15, endCol: 21, table: 'o', tableLine: 0, tableCol: 13, tableEndCol: 14 },
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtReferenceProvider(indexer, createMockLogger(), ps);
		const doc = createMockDocument('select o.id, o.amount\nfrom orders o');
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
		const mockModel: Partial<DocumentModel> = {
			ctes: [],
			refs: [],
			tokens: [
				{
					type: 'table_ref',
					name: 'orders',
					line: 1, col: 5, endCol: 11,
					alias: 'o',
					aliasLine: 1, aliasCol: 12, aliasEndCol: 13,
				},
				{
					type: 'column_ref', name: 'id', line: 0, col: 7, endCol: 9,
					table: 'o', tableLine: 0, tableCol: 5, tableEndCol: 6,
					resolvedTableRef: {
						type: 'table_ref', name: 'orders', line: 1, col: 5, endCol: 11,
						alias: 'o', aliasLine: 1, aliasCol: 12, aliasEndCol: 13,
					},
				},
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtReferenceProvider(indexer, createMockLogger(), ps);
		const doc = createMockDocument('select o.id\nfrom orders o');
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

	it('prepareRename returns column range for column_ref token', async () => {
		const mockModel: Partial<DocumentModel> = {
			tokens: [
				{ type: 'column_ref', name: 'order_id', line: 0, col: 7, endCol: 15 },
			],
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

	it('prepareRename returns alias range for table_alias token', async () => {
		const mockModel: Partial<DocumentModel> = {
			tokens: [
				{
					type: 'table_ref', name: 'orders', line: 1, col: 5, endCol: 11,
					alias: 'o', aliasLine: 1, aliasCol: 12, aliasEndCol: 13,
				},
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('select o.id\nfrom orders o');
		const pos = new vscode.Position(1, 12); // cursor on alias 'o'

		const result = await localProvider.prepareRename(doc, pos, mockToken) as { range: vscode.Range; placeholder: string };
		expect(result.placeholder).toBe('o');
		expect(result.range.start.character).toBe(12);
	});

	it('prepareRename returns alias range for table_qualifier token', async () => {
		const tableRef = { type: 'table_ref' as const, name: 'orders', line: 1, col: 5, endCol: 11, alias: 'o', aliasLine: 1, aliasCol: 12, aliasEndCol: 13 };
		const mockModel: Partial<DocumentModel> = {
			tokens: [
				tableRef,
				{
					type: 'column_ref', name: 'id', line: 0, col: 9, endCol: 11,
					table: 'o', tableLine: 0, tableCol: 7, tableEndCol: 8,
					resolvedTableRef: tableRef,
				},
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('select o.id\nfrom orders o');
		const pos = new vscode.Position(0, 7); // cursor on qualifier 'o' in 'o.id'

		const result = await localProvider.prepareRename(doc, pos, mockToken) as { range: vscode.Range; placeholder: string };
		expect(result.placeholder).toBe('o');
	});

	it('prepareRename returns CTE name range for table_ref on CTE', async () => {
		const mockModel: Partial<DocumentModel> = {
			ctes: [{ name: 'base', line: 0, col: 5, endLine: 0, endCol: 9, columns: [] }],
			tokens: [
				{ type: 'table_ref', name: 'base', line: 1, col: 14, endCol: 18 },
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('with base as (select 1),\nselect * from base');
		const pos = new vscode.Position(1, 16); // cursor on 'base' table_ref

		const result = await localProvider.prepareRename(doc, pos, mockToken) as { range: vscode.Range; placeholder: string };
		expect(result.placeholder).toBe('base');
	});

	it('provideRenameEdits renames all column occurrences in-file', async () => {
		const mockModel: Partial<DocumentModel> = {
			tokens: [
				{ type: 'column_def', name: 'order_id', line: 0, col: 7, endCol: 15 },
				{ type: 'column_ref', name: 'order_id', line: 1, col: 4, endCol: 12 },
				{ type: 'column_ref', name: 'order_id', line: 2, col: 0, endCol: 8 },
				{ type: 'column_ref', name: 'amount',   line: 1, col: 14, endCol: 20 },
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
		const mockModel: Partial<DocumentModel> = {
			tokens: [
				{ type: 'table_ref', name: 'orders', line: 1, col: 5, endCol: 11, alias: 'o', aliasLine: 1, aliasCol: 12, aliasEndCol: 13 },
				{ type: 'column_ref', name: 'id',     line: 0, col: 9,  endCol: 11, table: 'o', tableLine: 0, tableCol: 7, tableEndCol: 8 },
				{ type: 'column_ref', name: 'amount', line: 0, col: 14, endCol: 20, table: 'o', tableLine: 0, tableCol: 12, tableEndCol: 13 },
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('select o.id, o.amount\nfrom orders o');
		const pos = new vscode.Position(1, 12); // cursor on alias 'o'

		const result = await localProvider.provideRenameEdits(doc, pos, 'ord', mockToken);
		expect(result).toBeInstanceOf(vscode.WorkspaceEdit);
		const entries = result!.entries();
		const totalEdits = entries.reduce((s, [, edits]) => s + edits.length, 0);
		// alias site + 2 qualifier spans = 3
		expect(totalEdits).toBe(3);
	});

	it('provideRenameEdits renames CTE name definition and all usages', async () => {
		const mockModel: Partial<DocumentModel> = {
			ctes: [{ name: 'base', line: 0, col: 5, endLine: 0, endCol: 9, columns: [] }],
			tokens: [
				{ type: 'table_ref', name: 'base', line: 0, col: 5, endCol: 9 },  // cte keyword site
				{ type: 'table_ref', name: 'base', line: 1, col: 14, endCol: 18 }, // usage in FROM
			],
		};
		const ps = createMockParseServiceWithModel(mockModel);
		const localProvider = new DbtRenameProvider(indexer, createMockLoader(), createMockLogger(), ps);
		const doc = createMockDocument('with base as (select 1),\nselect * from base');
		const pos = new vscode.Position(1, 16); // cursor on usage 'base'

		const result = await localProvider.provideRenameEdits(doc, pos, 'foundation', mockToken);
		expect(result).toBeInstanceOf(vscode.WorkspaceEdit);
		const entries = result!.entries();
		const totalEdits = entries.reduce((s, [, edits]) => s + edits.length, 0);
		// CTE def name + 2 table_ref tokens
		expect(totalEdits).toBe(3);
	});
});

// --------------- CodeLensProvider ---------------

describe('SqlCodeLensProvider', () => {
	let provider: SqlCodeLensProvider;
	let indexer: ManifestIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = createMockIndexer();
		provider = new SqlCodeLensProvider(indexer, createMockLogger());
		provider.setPathResolver(createMockPathResolver({
			'/project/models/customers.sql': 'model',
			'/project/models/orders.sql': 'model',
		}));
	});

	it('provides Run/Build/Test/Compile lenses for known SQL model', () => {
		const doc = createMockDocument('{{ config(materialized=\'table\') }}\nselect 1', {
			fileName: '/project/models/customers.sql',
		});

		const result = provider.provideCodeLenses(doc, mockToken);
		expect(result.length).toBe(5);

		const titles = result.map(l => l.command?.title);
		expect(titles).toContain('$(run) Run');
		expect(titles).toContain('$(package) Build');
		expect(titles).toContain('$(beaker) Test');
		expect(titles).toContain('$(gear) Compile');
		expect(titles).toContain('$(clock) Profile');

		expect(result[0].command?.command).toBe('dbt-studio.runModel');
	});

	it('shows ad-hoc Run lenses for unknown model', () => {
		const doc = createMockDocument('SELECT 1;\nSELECT 2', {
			fileName: '/project/analyses/scratch.sql',
		});

		const result = provider.provideCodeLenses(doc, mockToken);
		const titles = result.map(l => l.command?.title);
		expect(titles).toContain('$(run-all) Run All (2)');
		expect(titles.filter(t => t === '$(play) Run')).toHaveLength(2);
	});

	it('shows single Run lens for unknown model with one statement', () => {
		const doc = createMockDocument('SELECT 1', {
			fileName: '/project/analyses/scratch.sql',
		});

		const result = provider.provideCodeLenses(doc, mockToken);
		expect(result).toHaveLength(1);
		expect(result[0].command?.title).toBe('$(play) Run');
		expect(result[0].command?.command).toBe('dbt-studio.executeStatement');
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
		provider = new DbtSignatureHelpProvider(createMockIndexer(), createMockLogger());
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
		const p = new DbtSignatureHelpProvider(indexer, createMockLogger());

		const doc = createMockDocument('{{ no_args(');
		const pos = new vscode.Position(0, 11);
		const ctx = {} as vscode.SignatureHelpContext;

		const result = p.provideSignatureHelp(doc, pos, mockToken, ctx);
		expect(result).toBeUndefined();
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
		expect(actions.length).toBe(1);
		expect(actions[0].title).toContain('nonexistent_model');
		expect(actions[0].command?.command).toBe('dbt-studio.createModelFile');
		expect(actions[0].isPreferred).toBe(true);
	});

	it('returns empty for existing model refs', () => {
		const doc = createMockDocument('select * from {{ ref(\'customers\') }}');
		const range = new vscode.Range(0, 0, 0, 36);
		const ctx = { diagnostics: [] } as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		expect(actions).toEqual([]);
	});

	it('has QuickFix as provided code action kind', () => {
		expect(SqlCodeActionProvider.providedCodeActionKinds).toContain(vscode.CodeActionKind.QuickFix);
	});
});
