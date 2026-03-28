import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { DbtReferenceProvider } from '../providers/reference-provider';
import { DbtRenameProvider } from '../providers/rename-provider';
import { DbtCodeLensProvider } from '../providers/codelens-provider';
import { DbtDocumentSymbolProvider } from '../providers/document-symbol-provider';
import { DbtWorkspaceSymbolProvider } from '../providers/workspace-symbol-provider';
import { DbtSignatureHelpProvider } from '../providers/signature-help-provider';
import { DbtCodeActionProvider } from '../providers/code-action-provider';
import { createMockLogger } from './helpers';
import type { ManifestIndexer, ManifestIndex, IndexedModel, IndexedSource, IndexedMacro } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ParseService } from '../services/parse-service';

function createMockParseService(): ParseService {
	return { getDocumentModel: vi.fn().mockResolvedValue(null) } as unknown as ParseService;
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

	it('prepareRename returns range and placeholder for ref()', () => {
		const doc = createMockDocument('select * from {{ ref(\'customers\') }}');
		const pos = new vscode.Position(0, 26); // cursor on 'customers'

		const result = provider.prepareRename(doc, pos, mockToken);
		expect(result).toBeDefined();
		expect((result as { placeholder: string }).placeholder).toBe('customers');
	});

	it('prepareRename throws for non-ref positions', () => {
		const doc = createMockDocument('select * from orders');
		const pos = new vscode.Position(0, 5);

		expect(() => provider.prepareRename(doc, pos, mockToken)).toThrow();
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

	it('provideRenameEdits returns undefined when cursor not on ref', async () => {
		const doc = createMockDocument('select * from orders');
		const pos = new vscode.Position(0, 5);

		const result = await provider.provideRenameEdits(doc, pos, 'new_name', mockToken);
		expect(result).toBeUndefined();
	});
});

// --------------- CodeLensProvider ---------------

describe('DbtCodeLensProvider', () => {
	let provider: DbtCodeLensProvider;
	let indexer: ManifestIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = createMockIndexer();
		provider = new DbtCodeLensProvider(indexer, createMockLogger());
	});

	it('provides Run/Build/Test/Compile lenses for known SQL model', () => {
		const doc = createMockDocument('{{ config(materialized=\'table\') }}\nselect 1', {
			fileName: '/project/models/customers.sql',
		});

		const result = provider.provideCodeLenses(doc, mockToken);
		expect(result.length).toBe(4);

		const titles = result.map(l => l.command?.title);
		expect(titles).toContain('$(run) Run');
		expect(titles).toContain('$(package) Build');
		expect(titles).toContain('$(beaker) Test');
		expect(titles).toContain('$(gear) Compile');

		expect(result[0].command?.command).toBe('dbt-studio.runModel');
	});

	it('returns empty for unknown model', () => {
		const doc = createMockDocument('select 1', {
			fileName: '/project/models/unknown_model.sql',
		});

		const result = provider.provideCodeLenses(doc, mockToken);
		expect(result).toEqual([]);
	});

	it('returns empty for non-SQL/YAML documents', () => {
		const doc = createMockDocument('some content', {
			languageId: 'markdown',
			fileName: '/project/README.md',
		});

		const result = provider.provideCodeLenses(doc, mockToken);
		expect(result).toEqual([]);
	});

	it('fires onDidChangeCodeLenses when refresh() is called', () => {
		const listener = vi.fn();
		provider.onDidChangeCodeLenses(listener);
		provider.refresh();
		expect(listener).toHaveBeenCalled();
	});
});

// --------------- DocumentSymbolProvider ---------------

describe('DbtDocumentSymbolProvider', () => {
	let provider: DbtDocumentSymbolProvider;

	beforeEach(() => {
		vi.clearAllMocks();
		provider = new DbtDocumentSymbolProvider(createMockIndexer(), createMockLogger(), createMockParseService());
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

describe('DbtCodeActionProvider', () => {
	let provider: DbtCodeActionProvider;
	let indexer: ManifestIndexer;

	beforeEach(() => {
		vi.clearAllMocks();
		indexer = createMockIndexer();
		provider = new DbtCodeActionProvider(indexer, createMockLogger());
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

	it('returns empty for non-SQL documents', () => {
		const doc = createMockDocument('ref(\'test\')', {
			languageId: 'yaml',
			fileName: '/project/schema.yml',
		});
		const range = new vscode.Range(0, 0, 0, 11);
		const ctx = { diagnostics: [] } as unknown as vscode.CodeActionContext;

		const actions = provider.provideCodeActions(doc, range, ctx, mockToken);
		expect(actions).toEqual([]);
	});

	it('has QuickFix as provided code action kind', () => {
		expect(DbtCodeActionProvider.providedCodeActionKinds).toContain(vscode.CodeActionKind.QuickFix);
	});
});
