import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, cte } from './helpers';
import { cteBlankLineRule } from '../../ninja/rules/layout-cte-blank-line';

const RULE = 'ninja.layout.cte-blank-line';

function check(sql: string, ctes: ReturnType<typeof cte>[]) {
	const doc = mockDocument(sql);
	const m = model({ ctes });
	return cteBlankLineRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── Not enough CTEs ────────────────────────────────────────────────────

	it('no violation when there are no CTEs', () => {
		expect(check('select 1', [])).toHaveLength(0);
	});

	it('no violation when there is only one CTE', () => {
		const sql = 'with cte as (\n    select 1\n)\nselect * from cte';
		expect(check(sql, [cte('cte', 0, 2, [], 5, 1)])).toHaveLength(0);
	});

	// ── Blank line present ─────────────────────────────────────────────────

	it('no violation when blank line separates two CTEs', () => {
		// line 0: with cte1 as (
		// line 1:     select 1
		// line 2: ),
		// line 3: (blank)
		// line 4: cte2 as (
		// line 5:     select 2
		// line 6: )
		const sql = 'with cte1 as (\n    select 1\n),\n\ncte2 as (\n    select 2\n)\nselect 1';
		const v = check(sql, [
			cte('cte1', 0, 2, [], 5, 1),
			cte('cte2', 4, 6, [], 0, 1),
		]);
		expect(v).toHaveLength(0);
	});

	it('no violation with multiple blank lines between CTEs', () => {
		const sql = 'with cte1 as (\n    select 1\n),\n\n\ncte2 as (\n    select 2\n)\nselect 1';
		const v = check(sql, [
			cte('cte1', 0, 2, [], 5, 1),
			cte('cte2', 5, 7, [], 0, 1),
		]);
		expect(v).toHaveLength(0);
	});

	// ── Missing blank line ─────────────────────────────────────────────────

	it('flags missing blank line between two CTEs', () => {
		// line 0: with cte1 as (
		// line 1:     select 1
		// line 2: ),
		// line 3: cte2 as (     ← no blank line
		// line 4:     select 2
		// line 5: )
		const sql = 'with cte1 as (\n    select 1\n),\ncte2 as (\n    select 2\n)\nselect 1';
		const v = check(sql, [
			cte('cte1', 0, 2, [], 5, 1),
			cte('cte2', 3, 5, [], 0, 1),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('cte2');
	});

	it('flags missing blank line when ) and next CTE are on consecutive lines', () => {
		// closing ) on line 2, next CTE starts on line 3 — no gap at all
		const sql = 'with a as (\n    select 1\n),\nb as (\n    select 2\n)\nselect 1';
		const v = check(sql, [
			cte('a', 0, 2, [], 5, 1),
			cte('b', 3, 5, [], 0, 1),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('b');
	});

	// ── Three or more CTEs ─────────────────────────────────────────────────

	it('flags all missing blank lines in a three-CTE query', () => {
		// a: 0-2, b: 3-5, c: 6-8 → no blank lines between any pair
		const sql = [
			'with a as (',
			'    select 1',
			'),',
			'b as (',
			'    select 2',
			'),',
			'c as (',
			'    select 3',
			')',
			'select 1',
		].join('\n');
		const v = check(sql, [
			cte('a', 0, 2, [], 5, 1),
			cte('b', 3, 5, [], 0, 1),
			cte('c', 6, 8, [], 0, 1),
		]);
		expect(v).toHaveLength(2);
		expect(v.map(x => x.message)).toEqual(
			expect.arrayContaining([
				expect.stringContaining('b'),
				expect.stringContaining('c'),
			]),
		);
	});

	it('flags only the pair missing a blank line', () => {
		// a-b: no blank line, b-c: has blank line
		const sql = [
			'with a as (',
			'    select 1',
			'),',
			'b as (',
			'    select 2',
			'),',
			'',
			'c as (',
			'    select 3',
			')',
			'select 1',
		].join('\n');
		const v = check(sql, [
			cte('a', 0, 2, [], 5, 1),
			cte('b', 3, 5, [], 0, 1),
			cte('c', 7, 9, [], 0, 1),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('b');
	});

	// ── No violation after last CTE ────────────────────────────────────────

	it('does not require blank line after the last CTE', () => {
		const sql = 'with cte1 as (\n    select 1\n),\ncte2 as (\n    select 2\n)\nselect * from cte2';
		// cte1→cte2: no blank line → 1 violation; nothing required after cte2
		const v = check(sql, [
			cte('cte1', 0, 2, [], 5, 1),
			cte('cte2', 3, 5, [], 0, 1),
		]);
		expect(v).toHaveLength(1);
	});

	// ── Subquery aliases are skipped ───────────────────────────────────────

	it('skips pairs involving subquery aliases', () => {
		const sql = 'select * from (select 1) sub1, (select 2) sub2';
		const v = check(sql, [
			{ ...cte('sub1', 0, 0, [], 14, 24), isSubquery: true },
			{ ...cte('sub2', 0, 0, [], 31, 41), isSubquery: true },
		]);
		expect(v).toHaveLength(0);
	});

	// ── Range accuracy ─────────────────────────────────────────────────────

	it('range points to the next CTE name', () => {
		const sql = 'with cte1 as (\n    select 1\n),\ncte2 as (\n    select 2\n)\nselect 1';
		const v = check(sql, [
			cte('cte1', 0, 2, [], 5, 1),
			cte('cte2', 3, 5, [], 0, 1),
		]);
		expect(v[0].range.start.line).toBe(3);
		expect(v[0].range.start.character).toBe(0);
		expect(v[0].range.end.character).toBe(4); // 'cte2'.length
	});
});
