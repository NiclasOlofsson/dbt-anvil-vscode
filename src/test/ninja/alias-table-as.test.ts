import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sym, symbolBindings, applyEditsToText } from './helpers';
import { tableAsRule } from '../../ninja/rules/alias-table-as';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.aliasing.table-as';

describe(RULE, () => {
	it('flags alias without AS keyword', () => {
		// "select * from orders o" — orders at col 14, alias 'o' at col 21
		const sql = 'select * from orders o';
		const ref = sym('table', 'orders', 0, 14);
		const alias = sym('alias', 'o', 0, 21, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('\'o\'');
	});

	it('no violation when alias uses AS keyword', () => {
		// "select * from orders AS o" — orders at col 14, alias 'o' at col 24
		const sql = 'select * from orders AS o';
		const ref = sym('table', 'orders', 0, 14);
		const alias = sym('alias', 'o', 0, 24, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v).toHaveLength(0);
	});

	it('no violation when alias uses lowercase as keyword', () => {
		const sql = 'select * from orders as o';
		const ref = sym('table', 'orders', 0, 14);
		const alias = sym('alias', 'o', 0, 24, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v).toHaveLength(0);
	});

	it('autofix inserts AS before alias', () => {
		const sql = 'select * from orders o';
		const ref = sym('table', 'orders', 0, 14);
		const alias = sym('alias', 'o', 0, 21, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v[0].action?.type).toBe(FixAction.TYPE);
		const fixed = applyEditsToText(sql, (v[0].action as FixAction).ops);
		expect(fixed).toBe('select * from orders AS o');
	});

	it('no violation for table ref without alias', () => {
		const sql = 'select * from orders';
		const ref = sym('table', 'orders', 0, 14);
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref] });
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('skips CTE definition tokens', () => {
		// A CTE's own declaration site is a separate Sym (kind 'cte', modifiers
		// ['declaration']) — it never carries the 'reference' modifier, so the
		// rule's relation-ref filter excludes it without a separate check.
		const sql = 'with orders as (select 1)';
		const cteDecl = sym('cte', 'orders', 0, 5, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [cteDecl] });
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('disabled when explicitAs is false', () => {
		const sql = 'select * from orders o';
		const ref = sym('table', 'orders', 0, 14);
		const alias = sym('alias', 'o', 0, 21, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		const c = cfg({ convention: { ...cfg().convention, explicitAs: false } });
		expect(tableAsRule.check({ model: m, document: doc, config: c })).toHaveLength(0);
	});

	it('no violations without symbols', () => {
		const doc = mockDocument('select * from orders o');
		const m = model({});
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('no violation for subquery alias with AS keyword: ") as po"', () => {
		// `from (select 1) as po`. A subquery source's relation Sym has kind
		// 'subquery' and its own span points at the alias identifier itself (no
		// underlying table name is being renamed) — same position as the alias
		// Sym. The rule must look at the text right BEFORE the alias instead of
		// between the (empty) name-to-alias gap.
		const sql = 'select * from (select 1) as po';
		// 'po' starts at col 28 (0-based).
		const ref = sym('subquery', 'po', 0, 28);
		const alias = sym('alias', 'po', 0, 28, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('flags subquery alias missing AS: ") po"', () => {
		const sql = 'select * from (select 1) po';
		const ref = sym('subquery', 'po', 0, 25);
		const alias = sym('alias', 'po', 0, 25, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(1);
	});

	it('does not false-positive when the table name itself ends with "as": "from views_as o"', () => {
		// `\bAS\b` could match the trailing `as` inside the table name; the
		// regex anchors must reject that. Source: `views_as o`.
		const sql = 'select * from views_as o';
		// views_as at col 14, alias 'o' at col 23.
		const ref = sym('table', 'views_as', 0, 14);
		const alias = sym('alias', 'o', 0, 23, { modifiers: ['declaration'] });
		const doc = mockDocument(sql);
		const m = model({ symbols: [ref, alias], symbolBindings: symbolBindings({ aliasOf: [[ref, alias]] }) });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('\'o\'');
	});
});
