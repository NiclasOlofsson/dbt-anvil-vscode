/**
 * AnvilTemplateProvider: the manifest-sourced half of sqllens's template contract.
 * The shape answer decides what parseTemplated fills into a macro tag, so a wrong
 * answer surfaces as a SQL syntax error (or a silently mis-shaped parse) on a real
 * model; the catalog answers decide what completion offers in a jinja call slot.
 */
import { describe, expect, it } from 'vitest';
import { makeTemplateProvider } from '../../../ftl/sqllens/template-shape';
import type { SchemaProvider, TemplateCall } from '../../../ftl/sqllens/api';
import type { ManifestIndexer } from '../../../indexing/manifest-indexer';
import type { DescribeCache } from '../../../dbt/describe-cache';
import { macroShapeLookup } from '../../helpers';

const call = (name: string, args: (string | null)[]): TemplateCall => ({ name, args });

/** A provider over a small manifest catalog — the half sqllens can never know. */
function providerWithCatalog() {
	const models = new Map<string, unknown>([
		['model.p.customers', { name: 'customers', materialisation: 'table', packageName: 'p' }],
		['model.p.orders', { name: 'orders', materialisation: 'view', packageName: 'p' }],
	]);
	const sources = new Map<string, unknown>([
		['source.p.raw.orders', { name: 'orders', sourceName: 'raw' }],
		['source.p.raw.customers', { name: 'customers', sourceName: 'raw' }],
		['source.p.stg.orders', { name: 'orders', sourceName: 'stg' }],
		['source.p.stg.shipments', { name: 'shipments', sourceName: 'stg' }],
	]);
	const macros = new Map<string, unknown>([
		['macro.p.my_macro', { name: 'my_macro', packageName: 'p' }],
		['macro.dbt_utils.star', { name: 'star', packageName: 'dbt_utils' }],
	]);
	const functions = new Map<string, unknown>([
		['function.p.is_positive_int', { name: 'is_positive_int', packageName: 'p', functionType: 'scalar' }],
		['function.other_pkg.total_amount', { name: 'total_amount', packageName: 'other_pkg', functionType: 'aggregate' }],
	]);
	const indexer = { index: { models, sources, macros, functions } } as unknown as ManifestIndexer;
	const describeCache = { columns: () => Promise.resolve(undefined) } as unknown as DescribeCache;
	return makeTemplateProvider(() => undefined, { indexer, describeCache });
}

describe('AnvilTemplateProvider — templateCandidates (the dbt catalog seam)', () => {
	// sqllens detects WHICH slot the caret is in; these answer WHAT goes there. The dbt
	// meaning of each slot is knowledge sqllens cannot have.

	it('callee slot offers dbt builtins alongside macros', () => {
		const labels = providerWithCatalog().templateCandidates(call('re', []), -1).map(c => c.label);
		// `ref`/`source` live in no manifest map, so if we don't name them here they can
		// never be completed at all — the exact hole in the old macro-only list.
		expect(labels).toContain('ref');
		expect(labels).toContain('source');
		expect(labels).toContain('my_macro');
	});

	it('callee slot also offers `function` (dbt 1.11+ user-defined functions), alongside ref/source', () => {
		const labels = providerWithCatalog().templateCandidates(call('fun', []), -1).map(c => c.label);
		expect(labels).toContain('function');
	});

	it('function(...) slot offers function names, with the package in the detail', () => {
		const c = providerWithCatalog().templateCandidates(call('function', ['is_pos']), 0);
		expect(c.map(x => x.label).sort()).toEqual(['is_positive_int', 'total_amount']);
		const found = c.find(x => x.label === 'is_positive_int')!;
		expect(found.detail).toContain('p');
		expect(found.detail).toContain('scalar');
	});

	it('function 2-arg form: slot 0 is the PACKAGE, not a function name (arity comes from the whole call)', () => {
		const c = providerWithCatalog().templateCandidates(call('function', ['p', 'is_pos']), 0);
		expect(c.map(x => x.label)).toEqual(['other_pkg', 'p']);
		expect(c[0].detail).toBe('dbt package');
	});

	it('callee slot under a package offers only that package, no builtins', () => {
		const c = { name: 'st', args: [], packageParts: ['dbt_utils'] };
		expect(providerWithCatalog().templateCandidates(c, -1).map(x => x.label)).toEqual(['star']);
	});

	it('ref slot offers model names', () => {
		const c = providerWithCatalog().templateCandidates(call('ref', ['cu']), 0);
		expect(c.map(x => x.label).sort()).toEqual(['customers', 'orders']);
		expect(c.find(x => x.label === 'orders')!.detail).toContain('view');
	});

	it('ref 2-arg form: slot 0 is the PACKAGE, not a model (arity comes from the whole call)', () => {
		const c = providerWithCatalog().templateCandidates(call('ref', ['p', 'cu']), 0);
		expect(c.map(x => x.label)).toEqual(['p']);
		expect(c[0].detail).toBe('dbt package');
	});

	it('source arg 0 offers deduped source names', () => {
		expect(providerWithCatalog().templateCandidates(call('source', ['ra']), 0).map(c => c.label))
			.toEqual(['raw', 'stg']);
	});

	it('source arg 1 narrows to the tables OF the source named in arg 0', () => {
		// The whole-call signature (sqllens 1.4.0 #37) is what makes this possible.
		const labels = providerWithCatalog()
			.templateCandidates(call('source', ['raw', 'ord']), 1)
			.map(c => c.label).sort();
		expect(labels).toEqual(['customers', 'orders']); // raw's tables
		expect(labels).not.toContain('shipments');       // stg's table must not leak in
	});

	it('source arg 1 with a computed arg 0 names every table with its owners (never guesses)', () => {
		const orders = providerWithCatalog()
			.templateCandidates(call('source', [null, 'ord']), 1)
			.find(c => c.label === 'orders');
		expect(orders!.detail).toContain('raw');
		expect(orders!.detail).toContain('stg');
	});

	it('a macro argument offers nothing — we know its params, not their values', () => {
		expect(providerWithCatalog().templateCandidates(call('my_macro', ['x']), 0)).toEqual([]);
	});

	it('no manifest → no candidates, never a fabricated list', () => {
		expect(makeTemplateProvider(() => undefined).templateCandidates(call('ref', ['x']), 0)).toEqual([]);
	});
});

describe('AnvilTemplateProvider — tables() and childrenOf() (the SQL catalog seam sqllens completes over)', () => {
	// sqllens's completeAt reads these off the schema it is handed: tables() feeds the FROM-slot
	// `table` candidates; childrenOf() feeds qualified-path `namespace`/`table` segments. This is
	// the catalog half that replaced our FROM-line / FQN line-prefix regexes.

	function fqnProvider(): SchemaProvider {
		const models = new Map<string, unknown>([
			['model.pkg.gold__company', { name: 'gold__company', materialisation: 'table', packageName: 'pkg', schema: 'niclas_olofsson_gold', database: 'hive_metastore' }],
			['model.pkg.mart_serving__chep', { name: 'mart_serving__chep', materialisation: 'view', packageName: 'pkg', schema: 'niclas_olofsson_mart_serving', database: 'hive_metastore' }],
		]);
		const sources = new Map<string, unknown>([
			['source.pkg.raw.orders', { name: 'orders', sourceName: 'raw', schema: 'niclas_olofsson_raw', database: 'hive_metastore' }],
		]);
		const indexer = { index: { models, sources, macros: new Map() } } as unknown as ManifestIndexer;
		const describeCache = { columns: () => Promise.resolve(undefined) } as unknown as DescribeCache;
		return makeTemplateProvider(() => undefined, { indexer, describeCache });
	}

	it('tables() offers bare model names, deduped, and nothing without a manifest', () => {
		const p: SchemaProvider = providerWithCatalog();
		expect(p.tables().sort()).toEqual(['customers', 'orders']);
		expect((makeTemplateProvider(() => undefined) as SchemaProvider).tables()).toEqual([]);
	});

	it('childrenOf([catalog]) offers the schemas inside it as namespaces', () => {
		const namespaces = fqnProvider().childrenOf!(['hive_metastore'])
			.filter(k => k.kind === 'namespace').map(k => k.name).sort();
		expect(namespaces).toEqual(['niclas_olofsson_gold', 'niclas_olofsson_mart_serving', 'niclas_olofsson_raw']);
	});

	it('childrenOf([catalog, schema]) offers only that schema\'s relations as tables', () => {
		expect(fqnProvider().childrenOf!(['hive_metastore', 'niclas_olofsson_gold']))
			.toEqual([{ name: 'gold__company', kind: 'table' }]);
	});

	it('childrenOf([schema]) offers that schema\'s relations (the 2-part schema.table path)', () => {
		const tables = fqnProvider().childrenOf!(['niclas_olofsson_mart_serving'])
			.filter(k => k.kind === 'table').map(k => k.name);
		expect(tables).toEqual(['mart_serving__chep']);
	});

	it('childrenOf matches the catalog case-insensitively', () => {
		expect(fqnProvider().childrenOf!(['HIVE_METASTORE', 'NICLAS_OLOFSSON_GOLD']).map(k => k.name))
			.toEqual(['gold__company']);
	});

	it('childrenOf is empty without a manifest, and for an empty prefix', () => {
		expect((makeTemplateProvider(() => undefined) as SchemaProvider).childrenOf!(['x'])).toEqual([]);
		expect(fqnProvider().childrenOf!([])).toEqual([]);
	});
});


describe('AnvilTemplateProvider — shapeOf (macro shapes read by sqllens from the definition)', () => {
	/** A provider over one macro definition, the way ManifestIndexer.macroShape feeds it. */
	const over = (macroSql: string) =>
		makeTemplateProvider(macroShapeLookup(name => (name === 'm' || name === 'generic_is_deleted' ? macroSql : undefined), 'databricks'));
	const shapesOf = (macroSql: string, c: TemplateCall) => {
		const s = over(macroSql).shapeOf(c);
		return s === undefined || typeof s === 'string' ? s : [...s];
	};

	it('a query-bodied macro answers statement', () => {
		expect(shapesOf('{% macro m() %} with a as (select 1) select * from a {% endmacro %}', call('m', []))).toContain('statement');
		expect(shapesOf('{% macro m() %}select 1{% endmacro %}', call('m', []))).toContain('statement');
	});

	it('a trailing-conjunct macro answers conjunct', () => {
		expect(shapesOf('{% macro m(c) %}and {{ c }} = false{% endmacro %}', call('m', ['x']))).toContain('conjunct');
	});

	it('a WHERE-leading macro body answers where-clause', () => {
		expect(shapesOf('{% macro m(c) %}where {{ c }} = false{% endmacro %}', call('m', ['x']))).toContain('where-clause');
	});

	it('an unknown macro, or one the manifest has no source for, answers nothing', () => {
		expect(shapesOf('{% macro m() %}select 1{% endmacro %}', call('other', []))).toBeUndefined();
		expect(makeTemplateProvider(() => undefined).shapeOf(call('m', []))).toBeUndefined();
	});

	it('an empty sqllens answer is undefined, never an empty list', () => {
		// An empty body: nothing can be established about it.
		expect(shapesOf('{% macro m() %}{% endmacro %}', call('m', []))).toBeUndefined();
	});

	// A production soft-delete macro family: the MODE is an argument —
	// `{{ stat }} {{ column_name }}=false` — so the body alone establishes
	// nothing. The call site carries the literal mode word; sqllens resolves
	// the keyword hole per call.
	const MACRO = '{% macro generic_is_deleted(column_name,stat) %}\n    {{ stat }} {{ column_name }}=false\n{% endmacro %}';

	it('the and-mode call answers conjunct via the literal \'stat\' argument', () => {
		expect(shapesOf(MACRO, call('generic_is_deleted', ['ve.is_deleted', 'and']))).toContain('conjunct');
	});

	it('keeps the identifier fill when the mode arg is not a literal', () => {
		expect(shapesOf(MACRO, call('generic_is_deleted', [null, null]))).toBeUndefined();
	});

	it('binds kwargs the same way', () => {
		expect(shapesOf(MACRO, {
			name: 'generic_is_deleted',
			args: [],
			kwargs: [{ name: 'stat', value: 'and' }, { name: 'column_name', value: 'x' }],
		})).toContain('conjunct');
	});

	it('the where-mode call answers where-clause via the literal \'stat\' argument', () => {
		expect(shapesOf(MACRO, call('generic_is_deleted', ['ve.is_deleted', 'where']))).toContain('where-clause');
	});
});
