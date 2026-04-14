import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, cte, tableRef, colRef } from './helpers';
import { unusedColumnsRule } from '../../ninja/rules/structure-unused-columns';

const RULE = 'ninja.structure.unused-columns';

function check(sql: string, m: ReturnType<typeof model>) {
	const doc = mockDocument(sql);
	return unusedColumnsRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── Detection ───────────────────────────────────────────────────────────

	it('no violation when all columns are referenced', () => {
		const sql = 'with cte_a as (\n  select id, name\n)\nselect id, name from cte_a';
		const ref = tableRef('cte_a', 3, 22);
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id', 'name'])],
			tokens: [
				ref,
				colRef('id', 3, 7, 'cte_a', ref),
				colRef('name', 3, 11, 'cte_a', ref),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('flags unused column in CTE', () => {
		const sql = 'with cte_a as (\n  select id, name, email\n)\nselect id from cte_a';
		const ref = tableRef('cte_a', 3, 15);
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id', 'name', 'email'])],
			tokens: [
				ref,
				colRef('id', 3, 7, 'cte_a', ref),
			],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(2);
		expect(v.map(x => x.message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining('name'),
				expect.stringContaining('email'),
			]),
		);
	});

	it('skips CTEs with SELECT * (wildcard columns)', () => {
		const sql = 'with cte_a as (\n  select *\n)\nselect id from cte_a';
		const ref = tableRef('cte_a', 3, 15);
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['*'])],
			tokens: [
				ref,
				colRef('id', 3, 7, 'cte_a', ref),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('no violations when no CTEs exist', () => {
		const sql = 'select 1 from t';
		expect(check(sql, model())).toHaveLength(0);
	});

	it('skips CTEs with no columns', () => {
		const sql = 'with cte_a as (\n  select 1\n)\nselect * from cte_a';
		const m = model({
			ctes: [cte('cte_a', 0, 2, [])],
			tokens: [tableRef('cte_a', 3, 14)],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('case-insensitive column matching', () => {
		const sql = 'with cte_a as (\n  select ID\n)\nselect id from cte_a';
		const ref = tableRef('cte_a', 3, 15);
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['ID'])],
			tokens: [
				ref,
				colRef('id', 3, 7, 'cte_a', ref),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('distinguishes columns from different CTEs', () => {
		const sql = 'with a as (\n  select id, name\n),\nb as (\n  select code\n)\nselect id from a\njoin b on b.code = a.id';
		const refA = tableRef('a', 6, 15);
		const refB = tableRef('b', 7, 5);
		const m = model({
			ctes: [cte('a', 0, 2, ['id', 'name']), cte('b', 3, 5, ['code'])],
			tokens: [
				refA,
				refB,
				colRef('id', 6, 7, 'a', refA),
				colRef('code', 7, 7, 'b', refB),
				colRef('id', 7, 18, 'a', refA),
			],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('name');
		expect(v[0].message).toContain("CTE 'a'");
	});

	it('ignores column_refs inside the CTE body (self-references)', () => {
		// column_ref on line 1 is inside CTE body (line 0 to 2), should be ignored
		const sql = 'with cte_a as (\n  select id\n)\nselect 1';
		const ref = tableRef('cte_a', 1, 9);
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id'])],
			tokens: [
				ref,
				colRef('id', 1, 9, 'cte_a', ref), // inside CTE body
			],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('id');
	});

	it('uses table qualifier fallback when resolvedTableRef is absent', () => {
		const sql = 'with cte_a as (\n  select id\n)\nselect cte_a.id from cte_a';
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id'])],
			tokens: [
				tableRef('cte_a', 3, 20),
				// column_ref without resolvedTableRef but with table qualifier
				{ type: 'column_ref' as const, name: 'id', line: 3, col: 7, endCol: 9, table: 'cte_a' },
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('message includes CTE and column name', () => {
		const sql = 'with my_data as (\n  select total\n)\nselect 1';
		const m = model({
			ctes: [cte('my_data', 0, 2, ['total'])],
			tokens: [],
		});
		const v = check(sql, m);
		expect(v[0].message).toBe("Column 'total' in CTE 'my_data' is never referenced downstream.");
	});

	it('no fix is provided (info-only rule)', () => {
		const sql = 'with cte_a as (\n  select unused_col\n)\nselect 1';
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['unused_col'])],
			tokens: [],
		});
		const v = check(sql, m);
		expect(v[0].fix).toBeUndefined();
	});
});
