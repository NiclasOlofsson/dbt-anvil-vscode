/**
 * classifyMacroShape: the manifest-sourced expansion-shape classifier behind
 * AnvilTemplateProvider. The shape answer decides what parseTemplated fills
 * into a macro tag, so a wrong answer surfaces as a SQL syntax error (or a
 * silently mis-shaped parse) on a real model.
 */
import { describe, expect, it } from 'vitest';
import { classifyMacroShape, makeTemplateProvider } from '../../../ftl/sqllens/template-shape';
import type { TemplateCall } from '../../../ftl/sqllens/api';
import type { ManifestIndexer } from '../../../indexing/manifest-indexer';
import type { DescribeCache } from '../../../dbt/describe-cache';

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
	const indexer = { index: { models, sources, macros } } as unknown as ManifestIndexer;
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

describe('classifyMacroShape — body-leading keyword (no call context)', () => {
	it('classifies a query-bodied macro as statement', () => {
		expect(classifyMacroShape('{% macro m() %} with a as (select 1) select * from a {% endmacro %}')).toBe('statement');
		expect(classifyMacroShape('{% macro m() %}select 1{% endmacro %}')).toBe('statement');
	});

	it('classifies a trailing-conjunct macro as conjunct', () => {
		expect(classifyMacroShape('{% macro m(c) %}and {{ c }} = false{% endmacro %}')).toBe('conjunct');
	});

	it('answers nothing for an unknown-shaped body (identifier fill)', () => {
		expect(classifyMacroShape('{% macro m() %}{{ x }}::int{% endmacro %}')).toBeUndefined();
		expect(classifyMacroShape(undefined)).toBeUndefined();
	});
});

describe('classifyMacroShape — literal call args bound to parameters', () => {
	// A production soft-delete macro family: the MODE is an argument —
	// `{{ stat }} {{ column_name }}=false` — so the body alone classifies as
	// nothing. The call site carries the literal mode word; binding it lets the
	// and-mode call classify as a conjunct.
	const MACRO = '{% macro generic_is_deleted(column_name,stat) %}\n    {{ stat }} {{ column_name }}=false\n{% endmacro %}';

	it('classifies the and-mode call as conjunct via the bound \'stat\' literal', () => {
		expect(classifyMacroShape(MACRO, call('generic_is_deleted', ['ve.is_deleted', 'and']))).toBe('conjunct');
	});

	it('keeps the identifier fill when the mode arg is not a literal', () => {
		// literalOf answers null for computed/non-string args — nothing to bind.
		expect(classifyMacroShape(MACRO, call('generic_is_deleted', [null, null]))).toBeUndefined();
	});

	it('binds kwargs the same way', () => {
		expect(classifyMacroShape(MACRO, {
			name: 'generic_is_deleted',
			args: [],
			kwargs: [{ name: 'stat', value: 'and' }, { name: 'column_name', value: 'x' }],
		})).toBe('conjunct');
	});

	it('classifies the where-mode call as where-clause via the bound \'stat\' literal', () => {
		// sqllens a269062 shipped the where-clause shape (fills WHERE 1=1),
		// valid in both where-mode slots (`from t <tag>` and `on (...) <tag>`).
		expect(classifyMacroShape(MACRO, call('generic_is_deleted', ['ve.is_deleted', 'where']))).toBe('where-clause');
	});

	it('classifies a WHERE-leading macro body as where-clause without call context', () => {
		expect(classifyMacroShape('{% macro m(c) %}where {{ c }} = false{% endmacro %}')).toBe('where-clause');
	});
});
