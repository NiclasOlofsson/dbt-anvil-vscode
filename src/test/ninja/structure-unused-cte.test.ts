import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, cte, tableRef, colRef, sqlTok } from './helpers';
import { unusedCteRule } from '../../ninja/rules/structure-unused-cte';
import type { NinjaConfig } from '../../ninja/config';

const RULE = 'ninja.structure.unused-cte';

function check(sql: string, m: ReturnType<typeof model>, config?: Partial<NinjaConfig>) {
	const doc = mockDocument(sql);
	return unusedCteRule.check({ model: m, document: doc, config: cfg(config) });
}

describe(RULE, () => {
	// ── Detection ───────────────────────────────────────────────────────────

	it('no violation when CTE is referenced', () => {
		const sql = 'with cte_a as (\n  select 1\n)\nselect * from cte_a';
		const m = model({
			ctes: [cte('cte_a', 0, 2)],
			tokens: [tableRef('cte_a', 3, 14)],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('flags single unused CTE', () => {
		const sql = 'with unused as (\n  select 1\n)\nselect 1';
		const m = model({
			ctes: [cte('unused', 0, 2)],
			tokens: [],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('unused');
	});

	it('flags only the unused CTE in multi-CTE query', () => {
		const sql = 'with a as (\n  select 1\n),\nb as (\n  select 2\n)\nselect * from a';
		const m = model({
			ctes: [cte('a', 0, 2), cte('b', 3, 5)],
			tokens: [tableRef('a', 6, 14)],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('b');
	});

	it('flags multiple unused CTEs', () => {
		const sql = 'with a as (\n  select 1\n),\nb as (\n  select 2\n)\nselect 1';
		const m = model({
			ctes: [cte('a', 0, 2), cte('b', 3, 5)],
			tokens: [],
		});
		expect(check(sql, m)).toHaveLength(2);
	});

	it('case-insensitive matching of CTE references', () => {
		const sql = 'with MyData as (\n  select 1\n)\nselect * from mydata';
		const m = model({
			ctes: [cte('MyData', 0, 2)],
			tokens: [tableRef('mydata', 3, 14)],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('no violations when no CTEs exist', () => {
		const sql = 'select 1 from t';
		const m = model({ ctes: [] });
		expect(check(sql, m)).toHaveLength(0);
	});

	it('no violation when CTE is used inside PIVOT/UNPIVOT (synthesized alias)', () => {
		// qualify() attaches a positionless alias to the Table node when a CTE is used
		// with PIVOT/UNPIVOT, causing synthesized=true. The table name is still real.
		const sql = 'with base as (\n  select 1\n)\nselect * from base unpivot (...)';
		const tok = { ...tableRef('base', 3, 14), synthesized: true as const };
		const m = model({
			ctes: [cte('base', 0, 2)],
			tokens: [tok],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('range points to CTE name', () => {
		const sql = 'with my_cte as (\n  select 1\n)\nselect 1';
		const m = model({
			ctes: [cte('my_cte', 0, 2, [], 5)],
			tokens: [],
		});
		const v = check(sql, m);
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(5);
		expect(v[0].range.end.character).toBe(11); // 5 + 'my_cte'.length
	});

	// ── Auto-fix: only CTE ─────────────────────────────────────────────────

	it('fix deletes entire WITH block for single CTE', () => {
		const sql = 'with unused as (\n  select 1\n)\nselect 1';
		const m = model({
			ctes: [cte('unused', 0, 2, [], 5, 1)],
			tokens: [],
			sqlTokens: [sqlTok('WITH', 0, 3, 0, 4)],
		});
		const v = check(sql, m);
		expect(v[0].fix).toBeDefined();
		expect(v[0].fix).toHaveLength(1);
		// Should delete from WITH through closing paren
		const edit = v[0].fix![0];
		expect(edit.range.start.line).toBe(0);
		expect(edit.range.end.line).toBe(3); // next line after )
	});

	// ── Auto-fix: first of many ────────────────────────────────────────────

	it('fix deletes first CTE up to second CTE name', () => {
		const sql = 'with unused as (\n  select 1\n),\nused as (\n  select 2\n)\nselect * from used';
		const m = model({
			ctes: [cte('unused', 0, 2, [], 5, 1), cte('used', 3, 5, [], 0, 1)],
			tokens: [tableRef('used', 6, 14)],
			sqlTokens: [sqlTok('WITH', 0, 3, 0, 4)],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].fix).toBeDefined();
		const edit = v[0].fix![0];
		// Should delete from CTE name line through to start of next CTE
		expect(edit.range.start.line).toBe(0);
		expect(edit.range.end.line).toBe(3);
		expect(edit.range.end.character).toBe(0);
	});

	// ── Auto-fix: last of many ─────────────────────────────────────────────

	it('fix deletes last CTE from prev closing paren', () => {
		const sql = 'with used as (\n  select 1\n),\nunused as (\n  select 2\n)\nselect * from used';
		const m = model({
			ctes: [cte('used', 0, 2, [], 5, 1), cte('unused', 3, 5, [], 0, 1)],
			tokens: [tableRef('used', 6, 14)],
			sqlTokens: [sqlTok('WITH', 0, 3, 0, 4)],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].fix).toBeDefined();
		const edit = v[0].fix![0];
		// Should start from end of previous CTE
		expect(edit.range.start.line).toBe(2);
		expect(edit.range.start.character).toBe(1); // endCol of prev CTE
	});

	// ── No fix without sqlTokens ────────────────────────────────────────────

	it('no fix when sqlTokens are missing', () => {
		const sql = 'with unused as (\n  select 1\n)\nselect 1';
		const m = model({
			ctes: [cte('unused', 0, 2)],
			tokens: [],
		});
		const v = check(sql, m);
		expect(v[0].fix).toBeUndefined();
	});

	// ── Rule can be turned off ──────────────────────────────────────────────

	it('respects severity off via config', () => {
		const sql = 'with unused as (\n  select 1\n)\nselect 1';
		const m = model({
			ctes: [cte('unused', 0, 2)],
			tokens: [],
		});
		// Rule is still invoked directly, severity is engine-level; just verify it produces violations
		expect(check(sql, m)).toHaveLength(1);
	});

	// ── cteDefinition tokens must not count as usages ───────────────────────

	it('flags CTE as unused when only cteDefinition tokens are present (not FROM/JOIN refs)', () => {
		// Regression: extractTokens() emits a cteDefinition:true token for every CTE definition
		// site. The rule must not count those as FROM/JOIN usages, or every CTE will appear
		// "referenced" and the rule will never fire.
		const sql = 'with cte_empty as (\n  select losing_team\n  from t\n  where 1 = 0\n)\nselect 1';
		const m = model({
			ctes: [cte('cte_empty', 0, 4)],
			// Only the cteDefinition token — no actual FROM/JOIN table_ref
			tokens: [{ type: 'table_ref' as const, name: 'cte_empty', line: 0, col: 5, endCol: 14, cteDefinition: true }],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('cte_empty');
	});
});
