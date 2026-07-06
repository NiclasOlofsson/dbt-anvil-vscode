import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sym } from './helpers';
import { qualifiedColumnsRule } from '../../ninja/rules/ambiguity-qualified-columns';

const RULE = 'ninja.ambiguity.qualified-columns';

function check(sql: string, m: ReturnType<typeof model>) {
	const doc = mockDocument(sql);
	return qualifiedColumnsRule.check({ model: m, document: doc, jinjaTokens: [], config: cfg() });
}

describe(RULE, () => {
	it('no violation with single table source', () => {
		const sql = 'select id from t';
		const m = model({
			symbols: [
				sym('table', 't', 0, 15),
				sym('column', 'id', 0, 7),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('flags unqualified column with multiple sources', () => {
		const sql = 'select id from t1 join t2 on t1.id = t2.id';
		const m = model({
			symbols: [
				sym('table', 't1', 0, 15),
				sym('table', 't2', 0, 23),
				sym('column', 'id', 0, 7), // unqualified
			],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('id');
		expect(v[0].message).toContain('unqualified');
	});

	it('no violation when all columns are qualified', () => {
		const sql = 'select t1.id, t2.name from t1 join t2 on t1.id = t2.id';
		const m = model({
			symbols: [
				sym('table', 't1', 0, 27),
				sym('table', 't2', 0, 35),
				sym('column', 't1.id', 0, 7),
				sym('column', 't2.name', 0, 14),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('flags multiple unqualified columns', () => {
		const sql = 'select id, name from t1 join t2 on t1.id = t2.id';
		const m = model({
			symbols: [
				sym('table', 't1', 0, 21),
				sym('table', 't2', 0, 29),
				sym('column', 'id', 0, 7),
				sym('column', 'name', 0, 11),
			],
		});
		expect(check(sql, m)).toHaveLength(2);
	});

	it('skips wildcard column refs', () => {
		const sql = 'select * from t1 join t2 on t1.id = t2.id';
		const m = model({
			symbols: [
				sym('table', 't1', 0, 14),
				sym('table', 't2', 0, 22),
				sym('column', '*', 0, 7, { modifiers: ['reference', 'star'] }),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('range points to column ref position', () => {
		const sql = 'select amount from orders join items on orders.id = items.id';
		const m = model({
			symbols: [
				sym('table', 'orders', 0, 19),
				sym('table', 'items', 0, 31),
				sym('column', 'amount', 0, 7),
			],
		});
		const v = check(sql, m);
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(7);
		expect(v[0].range.end.character).toBe(13);
	});

	it('no violations with zero table sources', () => {
		const sql = 'select 1';
		expect(check(sql, model())).toHaveLength(0);
	});

	it('no violation when single real FROM ref exists but cteDefinition tokens inflate the count', () => {
		// Regression: the CTE's own declaration-site symbol was counted toward the
		// table/CTE reference count, making a single-source query look like it had
		// 2+ sources, triggering false positives on unqualified columns.
		const sql = 'with cte_a as (\n  select id\n)\nselect id from cte_a';
		const m = model({
			symbols: [
				// CTE declaration site — modifiers:['declaration'], must NOT count toward the 2+ threshold
				sym('cte', 'cte_a', 0, 5, { modifiers: ['declaration'] }),
				// The real single FROM reference
				sym('cte', 'cte_a', 3, 15),
				// Unqualified column — should NOT be flagged since there is only 1 real source
				sym('column', 'id', 3, 7),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});
});
