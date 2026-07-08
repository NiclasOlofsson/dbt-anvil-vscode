import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, cte, sym, sqlTok } from './helpers';
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
		const cteRef = sym('cte', 'cte_a', 3, 22);
		const idCol = sym('column', 'id', 3, 7, { source: cteRef });
		const nameCol = sym('column', 'name', 3, 11, { source: cteRef });
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id', 'name'])],
			symbols: [cteRef, idCol, nameCol],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('flags unused column in CTE', () => {
		const sql = 'with cte_a as (\n  select id, name, email\n)\nselect id from cte_a';
		const cteRef = sym('cte', 'cte_a', 3, 15);
		const idCol = sym('column', 'id', 3, 7, { source: cteRef });
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id', 'name', 'email'])],
			symbols: [cteRef, idCol],
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
		const cteRef = sym('cte', 'cte_a', 3, 15);
		const idCol = sym('column', 'id', 3, 7, { source: cteRef });
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['*'])],
			symbols: [cteRef, idCol],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('skips CTEs whose SELECT list contains a qualified wildcard (cp.*)', () => {
		// `WITH cte_a AS (SELECT cp.*, co.companykey FROM ...)` — qualify()
		// expands `cp.*` into per-column entries with unreliable positions.
		// The rule used to fire one violation per expanded column, all
		// pointing at Ln 1 Col 1. With the token-stream wildcard probe it
		// should now skip the whole CTE.
		const sql = 'with cte_a as (\n  select cp.*, co.companykey\n  from cp\n  left join co on cp.id = co.id\n)\nselect id from cte_a';
		// 0-based line for the SELECT line (1) and STAR offset.
		// Tokens model the SELECT list shape we care about.
		const sqlTokens = [
			sqlTok('L_PAREN', 14, 14, 0, 15),    // CTE body open
			sqlTok('SELECT',  18, 23, 1, 8),     // 'select'
			sqlTok('VAR',     25, 26, 1, 11),    // 'cp'
			sqlTok('DOT',     27, 27, 1, 12),    // '.'
			sqlTok('STAR',    28, 28, 1, 13),    // '*'  ← the qualified wildcard
			sqlTok('COMMA',   29, 29, 1, 14),
			sqlTok('VAR',     31, 32, 1, 16),    // 'co'
			sqlTok('DOT',     33, 33, 1, 17),
			sqlTok('VAR',     34, 43, 1, 27),    // 'companykey'
			sqlTok('R_PAREN', 80, 80, 4, 1),     // CTE body close
		];
		// Post-qualify the CTE's columns array contains the expanded names
		// (with broken positions — line 0, no col, just what the bug
		// produces today). The token-stream check should still skip.
		const cteRef = sym('cte', 'cte_a', 5, 15);
		const idCol = sym('column', 'id', 5, 7, { source: cteRef });
		const m = model({
			ctes: [{
				name: 'cte_a',
				line: 0,
				endLine: 4,
				col: 5,
				endCol: 1,
				columns: [
					{ name: 'recid',      line: 0 },
					{ name: 'is_deleted', line: 0 },
					{ name: 'companykey', line: 0 },
				],
			}],
			sqlTokens,
			symbols: [cteRef, idCol],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('does NOT skip when the * is inside a subquery within the CTE body', () => {
		// `WITH cte_a AS (SELECT a, b FROM (SELECT * FROM t))` — the wildcard
		// belongs to the subquery, not the CTE's own SELECT list. CTE
		// columns (a, b) should still be checked.
		const sql = 'with cte_a as (\n  select a, b\n  from (select * from t)\n)\nselect a from cte_a';
		const sqlTokens = [
			sqlTok('L_PAREN',  14, 14, 0, 15),    // CTE body open → depth 1
			sqlTok('SELECT',   18, 23, 1, 8),
			sqlTok('VAR',      25, 25, 1, 10),     // 'a'
			sqlTok('COMMA',    26, 26, 1, 11),
			sqlTok('VAR',      28, 28, 1, 13),     // 'b'
			sqlTok('FROM',     32, 35, 2, 6),
			sqlTok('L_PAREN',  37, 37, 2, 8),      // subquery open → depth 2
			sqlTok('SELECT',   38, 43, 2, 14),
			sqlTok('STAR',     45, 45, 2, 16),     // STAR at depth 2 — ignored
			sqlTok('FROM',     47, 50, 2, 21),
			sqlTok('VAR',      52, 52, 2, 23),
			sqlTok('R_PAREN',  53, 53, 2, 24),     // subquery close → depth 1
			sqlTok('R_PAREN',  55, 55, 3, 1),      // CTE body close → depth 0
		];
		const cteRef = sym('cte', 'cte_a', 4, 14);
		const aCol = sym('column', 'a', 4, 7, { source: cteRef });
		const m = model({
			ctes: [{
				name: 'cte_a',
				line: 0,
				endLine: 3,
				col: 5,
				endCol: 1,
				columns: [
					{ name: 'a', line: 1, col: 9 },
					{ name: 'b', line: 1, col: 12 },
				],
			}],
			sqlTokens,
			symbols: [cteRef, aCol],
		});
		// Only 'b' is unused.
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('b');
	});

	it('does NOT skip on multiplication (a * b) inside the CTE body', () => {
		// Multiplication STAR is preceded by VAR, not SELECT/COMMA/DOT —
		// the wildcard probe should ignore it.
		const sql = 'with cte_a as (\n  select a, b\n  where x = a * b\n)\nselect a from cte_a';
		const sqlTokens = [
			sqlTok('L_PAREN', 14, 14, 0, 15),    // CTE body open
			sqlTok('SELECT',  18, 23, 1, 8),
			sqlTok('VAR',     25, 25, 1, 10),     // 'a'
			sqlTok('COMMA',   26, 26, 1, 11),
			sqlTok('VAR',     28, 28, 1, 13),     // 'b'
			sqlTok('WHERE',   32, 36, 2, 7),
			sqlTok('VAR',     38, 38, 2, 9),      // 'x'
			sqlTok('EQ',      40, 40, 2, 11),
			sqlTok('VAR',     42, 42, 2, 13),     // 'a'
			sqlTok('STAR',    44, 44, 2, 15),     // multiplication — prev VAR, ignored
			sqlTok('VAR',     46, 46, 2, 17),     // 'b'
			sqlTok('R_PAREN', 48, 48, 3, 1),
		];
		const cteRef = sym('cte', 'cte_a', 4, 14);
		const aCol = sym('column', 'a', 4, 7, { source: cteRef });
		const m = model({
			ctes: [{
				name: 'cte_a',
				line: 0,
				endLine: 3,
				col: 5,
				endCol: 1,
				columns: [
					{ name: 'a', line: 1, col: 9 },
					{ name: 'b', line: 1, col: 12 },
				],
			}],
			sqlTokens,
			symbols: [cteRef, aCol],
		});
		// Only 'b' is unused — multiplication STAR doesn't trigger skip.
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('b');
	});

	it('does NOT skip on COUNT(*)', () => {
		// COUNT(*) has STAR preceded by L_PAREN — the probe should ignore.
		const sql = 'with cte_a as (\n  select count(*), a, b\n)\nselect a from cte_a';
		const sqlTokens = [
			sqlTok('L_PAREN', 14, 14, 0, 15),    // CTE body open → depth 1
			sqlTok('SELECT',  18, 23, 1, 8),
			sqlTok('VAR',     25, 29, 1, 14),     // 'count'
			sqlTok('L_PAREN', 30, 30, 1, 15),     // COUNT( → depth 2
			sqlTok('STAR',    31, 31, 1, 16),     // STAR at depth 2 — ignored
			sqlTok('R_PAREN', 32, 32, 1, 17),     // close COUNT → depth 1
			sqlTok('COMMA',   33, 33, 1, 18),
			sqlTok('VAR',     35, 35, 1, 20),     // 'a'
			sqlTok('COMMA',   36, 36, 1, 21),
			sqlTok('VAR',     38, 38, 1, 23),     // 'b'
			sqlTok('R_PAREN', 40, 40, 2, 1),      // CTE body close
		];
		const cteRef = sym('cte', 'cte_a', 3, 14);
		const aCol = sym('column', 'a', 3, 7, { source: cteRef });
		const m = model({
			ctes: [{
				name: 'cte_a',
				line: 0,
				endLine: 2,
				col: 5,
				endCol: 1,
				columns: [
					{ name: 'count', line: 1, col: 9 },
					{ name: 'a',     line: 1, col: 20 },
					{ name: 'b',     line: 1, col: 23 },
				],
			}],
			sqlTokens,
			symbols: [cteRef, aCol],
		});
		const v = check(sql, m);
		// 'count' and 'b' unused; 'a' used.
		expect(v).toHaveLength(2);
		expect(v.map(x => x.message)).toEqual(expect.arrayContaining([
			expect.stringContaining('count'),
			expect.stringContaining('b'),
		]));
	});

	it('no violations when no CTEs exist', () => {
		const sql = 'select 1 from t';
		expect(check(sql, model())).toHaveLength(0);
	});

	it('skips CTEs with no columns', () => {
		const sql = 'with cte_a as (\n  select 1\n)\nselect * from cte_a';
		const m = model({
			ctes: [cte('cte_a', 0, 2, [])],
			symbols: [sym('cte', 'cte_a', 3, 14)],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('case-insensitive column matching', () => {
		const sql = 'with cte_a as (\n  select ID\n)\nselect id from cte_a';
		const cteRef = sym('cte', 'cte_a', 3, 15);
		const idCol = sym('column', 'id', 3, 7, { source: cteRef });
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['ID'])],
			symbols: [cteRef, idCol],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('distinguishes columns from different CTEs', () => {
		const sql = 'with a as (\n  select id, name\n),\nb as (\n  select code\n)\nselect id from a\njoin b on b.code = a.id';
		const refA = sym('cte', 'a', 6, 15);
		const refB = sym('cte', 'b', 7, 5);
		const idCol1 = sym('column', 'id', 6, 7, { source: refA });
		const codeCol = sym('column', 'code', 7, 7, { source: refB });
		const idCol2 = sym('column', 'id', 7, 18, { source: refA });
		const m = model({
			ctes: [cte('a', 0, 2, ['id', 'name']), cte('b', 3, 5, ['code'])],
			symbols: [refA, refB, idCol1, codeCol, idCol2],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('name');
		expect(v[0].message).toContain('CTE \'a\'');
	});

	it('ignores column references inside the CTE body (self-references)', () => {
		// column Sym on line 1 is inside CTE body (line 0 to 2), should be ignored
		const sql = 'with cte_a as (\n  select id\n)\nselect 1';
		const cteRef = sym('cte', 'cte_a', 1, 9);
		const idCol = sym('column', 'id', 1, 9, { source: cteRef }); // inside CTE body
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id'])],
			symbols: [cteRef, idCol],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('id');
	});

	// Under the old TokenInfo bridge, `colRef.resolvedTableRef` was resolved by a
	// same-scope heuristic that could miss a qualified reference, falling back to
	// matching the raw `.table` qualifier string directly. Phase 0 (commit
	// 5b8640b) replaced that heuristic with sqllens's real `Qualification.bindingOf`,
	// which resolves qualified *and* bare columns uniformly whenever the column is
	// genuinely in scope — so that fallback tier has no equivalent under Sym: a
	// column's bound source (`Sym.source`) either resolves correctly or is
	// genuinely unresolvable (out of scope / typo'd qualifier). This test now
	// covers the latter — an unresolved column must not count as a reference.
	it('unresolved column reference does not count as a downstream use', () => {
		const sql = 'with cte_a as (\n  select id\n)\nselect other.id from cte_a';
		const unresolvedCol = sym('column', 'other.id', 3, 7);
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['id'])],
			symbols: [sym('cte', 'cte_a', 3, 20), unresolvedCol], // no .source — unresolved
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('id');
	});

	it('message includes CTE and column name', () => {
		const sql = 'with my_data as (\n  select total\n)\nselect 1';
		const m = model({
			ctes: [cte('my_data', 0, 2, ['total'])],
			symbols: [],
		});
		const v = check(sql, m);
		expect(v[0].message).toBe('Column \'total\' in CTE \'my_data\' is never referenced downstream.');
	});

	it('no fix is provided (info-only rule)', () => {
		const sql = 'with cte_a as (\n  select unused_col\n)\nselect 1';
		const m = model({
			ctes: [cte('cte_a', 0, 2, ['unused_col'])],
			symbols: [],
		});
		const v = check(sql, m);
		expect(v[0].action).toBeUndefined();
	});

	it('no violation when CTE columns are consumed via SELECT * that qualify() expands to column_refs', () => {
		// qualify() expands SELECT * in cte_final to explicit column syms for each
		// column in cte_interim_calcs. The rule must treat those as proper references.
		const sql = [
			'with cte_interim_calcs as (', // line 0
			'  select game_id, home_team',  // line 1
			'),',                           // line 2
			'cte_final as (',               // line 3
			'  select *, home_score',       // line 4
			'  from cte_interim_calcs',     // line 5
			')',                            // line 6
			'select * from cte_final',      // line 7
		].join('\n');

		const refInterim = sym('cte', 'cte_interim_calcs', 5, 7);
		const refFinal = sym('cte', 'cte_final', 7, 14);

		// qualify() expanded cte_final's SELECT * → explicit column syms bound to cte_interim_calcs
		const gameId1 = sym('column', 'game_id', 4, 9, { source: refInterim });
		const homeTeam1 = sym('column', 'home_team', 4, 18, { source: refInterim });
		// home_score is explicitly selected in cte_final
		const homeScore = sym('column', 'home_score', 7, 7, { source: refFinal });
		// qualify() expanded outer SELECT * → explicit column syms bound to cte_final
		const gameId2 = sym('column', 'game_id', 7, 16, { source: refFinal });
		const homeTeam2 = sym('column', 'home_team', 7, 25, { source: refFinal });

		const m = model({
			ctes: [
				cte('cte_interim_calcs', 0, 2, ['game_id', 'home_team']),
				cte('cte_final', 3, 6, ['game_id', 'home_team', 'home_score']),
			],
			symbols: [refInterim, refFinal, gameId1, homeTeam1, homeScore, gameId2, homeTeam2],
		});

		expect(check(sql, m)).toHaveLength(0);
	});
});
