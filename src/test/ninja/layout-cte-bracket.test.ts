import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, cte } from './helpers';
import { cteBracketRule } from '../../ninja/rules/layout-cte-bracket';

const RULE = 'ninja.layout.cte-bracket';

function check(sql: string, ctes: ReturnType<typeof cte>[]) {
	const doc = mockDocument(sql);
	const m = model({ ctes });
	return cteBracketRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── No CTEs ────────────────────────────────────────────────────────────

	it('no violation when there are no CTEs', () => {
		const v = check('select 1', []);
		expect(v).toHaveLength(0);
	});

	// ── Single-line CTE (always a violation) ───────────────────────────────

	it('flags closing ) on same line as CTE name', () => {
		// cte on line 0, closing ) also on line 0
		const sql = 'with cte as (select 1)\nselect * from cte';
		const v = check(sql, [cte('cte', 0, 0, [], 5, 22)]);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('cte');
		expect(v[0].range.start.line).toBe(0);
	});

	it('flags closing ) when entire CTE is on one line (endLine === line)', () => {
		const sql = 'with my_cte as (select 1)\nselect 1';
		const v = check(sql, [cte('my_cte', 0, 0, [], 5, 25)]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('my_cte');
	});

	// ── Multi-line CTE: ) on its own line ─────────────────────────────────

	it('no violation when ) is on its own line', () => {
		const sql = 'with cte as (\n    select 1\n)\nselect * from cte';
		// line 0: "with cte as ("
		// line 1: "    select 1"
		// line 2: ")"  → endLine=2, endCol=1
		const v = check(sql, [cte('cte', 0, 2, [], 5, 1)]);
		expect(v).toHaveLength(0);
	});

	it('no violation when ) is on its own line with leading whitespace', () => {
		const sql = 'with cte as (\n    select 1\n    )\nselect * from cte';
		// line 2: "    )"  → endLine=2, endCol=5
		const v = check(sql, [cte('cte', 0, 2, [], 5, 5)]);
		expect(v).toHaveLength(0);
	});

	// ── Multi-line CTE: ) NOT on its own line ─────────────────────────────

	it('flags ) when there is content before it on the closing line', () => {
		// line 0: "with cte as ("
		// line 1: "    select 1)"  → endLine=1, endCol=14
		const sql = 'with cte as (\n    select 1)\nselect * from cte';
		const v = check(sql, [cte('cte', 0, 1, [], 5, 14)]);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(1);
	});

	// ── Multiple CTEs ──────────────────────────────────────────────────────

	it('flags multiple CTEs that violate the rule', () => {
		const sql = 'with a as (select 1),\nb as (select 2)\nselect 1';
		// a: line 0, endLine 0, endCol 20
		// b: line 1, endLine 1, endCol 15
		const v = check(sql, [
			cte('a', 0, 0, [], 5, 20),
			cte('b', 1, 1, [], 2, 15),
		]);
		expect(v).toHaveLength(2);
	});

	it('flags only the CTE that violates when mixed', () => {
		// a is single-line (violation), b is multi-line with ) on its own line (ok)
		const sql = 'with a as (select 1),\nb as (\n    select 2\n)\nselect 1';
		const v = check(sql, [
			cte('a', 0, 0, [], 5, 20),
			cte('b', 1, 3, [], 2, 1),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('a');
	});

	// ── Subquery aliases are skipped ───────────────────────────────────────

	it('skips subquery aliases', () => {
		const sql = 'select * from (select 1) sub';
		const subqueryCte = { ...cte('sub', 0, 0, [], 14, 24), isSubquery: true };
		const v = check(sql, [subqueryCte]);
		expect(v).toHaveLength(0);
	});

	// ── Range accuracy ─────────────────────────────────────────────────────

	it('range points to the closing ) character', () => {
		const sql = 'with cte as (select 1)\nselect 1';
		// ) is at position 21 → endCol=22
		const v = check(sql, [cte('cte', 0, 0, [], 5, 22)]);
		expect(v[0].range.start.character).toBe(21);
		expect(v[0].range.end.character).toBe(22);
	});
});
