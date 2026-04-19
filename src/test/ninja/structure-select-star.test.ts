import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, cte } from './helpers';
import { selectStarRule } from '../../ninja/rules/structure-select-star';

const RULE = 'ninja.structure.select-star';

function check(sql: string, m: ReturnType<typeof model>, allowStar = false) {
	const doc = mockDocument(sql);
	return selectStarRule.check({
		model: m,
		document: doc,
		config: cfg({ structure: { allowStarInCte: allowStar } }),
	});
}

describe(RULE, () => {
	it('flags SELECT * inside a CTE', () => {
		const sql = 'with cte_a as (\n  select *\n)\nselect * from cte_a';
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['*'])],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('cte_a');
	});

	it('no violation when CTE has explicit columns', () => {
		const sql = 'with cte_a as (\n  select id, name\n)\nselect * from cte_a';
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id', 'name'])],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('no violation when no CTEs exist', () => {
		const sql = 'select * from t';
		expect(check(sql, model())).toHaveLength(0);
	});

	it('flags multiple CTEs with SELECT *', () => {
		const sql = 'with a as (\n  select *\n),\nb as (\n  select *\n)\nselect 1';
		const m = model({
			ctes: [cte('a', 0, 2, ['*']), cte('b', 3, 5, ['*'])],
		});
		expect(check(sql, m)).toHaveLength(2);
	});

	it('respects allowStarInCte config', () => {
		const sql = 'with cte_a as (\n  select *\n)\nselect * from cte_a';
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['*'])],
		});
		expect(check(sql, m, true)).toHaveLength(0);
	});

	it('no auto-fix (info-only)', () => {
		const sql = 'with cte_a as (\n  select *\n)\nselect 1';
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['*'])],
		});
		const v = check(sql, m);
		expect(v[0].action).toBeUndefined();
	});

	it('message mentions CTE name', () => {
		const sql = 'with orders as (\n  select *\n)\nselect 1';
		const m = model({
			ctes: [cte('orders', 0, 2, ['*'])],
		});
		const v = check(sql, m);
		expect(v[0].message).toBe('Avoid SELECT * in CTE \'orders\' — use explicit column lists.');
	});
});
