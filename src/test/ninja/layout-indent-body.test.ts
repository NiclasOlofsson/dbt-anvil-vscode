import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { indentBodyRule } from '../../ninja/rules/layout-indent-body';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/parse-result';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return indentBodyRule.check({ model: m, document: doc, config: cfg() });
}

// sqlTok(type, start, end, line, col)
// col = 1-based exclusive end col

// ── SELECT body ────────────────────────────────────────────────────────────

describe('ninja.layout.indent-body', () => {
	it('flags column at col 0 under SELECT at col 0 (expected col 4)', () => {
		// select
		// a
		// from t
		const sql = 'select\na\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('VAR',    7,  7, 1, 1),
			sqlTok('FROM',   9, 12, 2, 4),
			sqlTok('VAR',   14, 14, 2, 6),
		];
		const v = check(sql, toks);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe('ninja.layout.indent-body');
		expect(v[0].message).toContain('column 4');
		expect(v[0].message).toContain('column 0');
	});

	it('no violation when column is at the expected col 4', () => {
		const sql = 'select\n    a\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('VAR',   11, 11, 1, 5),   // '    a' → col 4
			sqlTok('FROM',  13, 16, 2, 4),
			sqlTok('VAR',   18, 18, 2, 6),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('does not flag columns on the same line as SELECT', () => {
		const sql = 'select a, b from t';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('VAR',     7,  7, 0, 8),
			sqlTok('COMMA',   8,  8, 0, 9),
			sqlTok('VAR',    10, 10, 0, 11),
			sqlTok('FROM',   12, 15, 0, 16),
			sqlTok('VAR',    17, 17, 0, 18),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('does not flag arithmetic operator at line start (expression continuation)', () => {
		// select
		//     a
		//         + b
		// from t
		// `+ b` is a wrap of the previous expression, not a new clause-body
		// token — the formatter places it at the continuation indent, and
		// indent-body must not pull it back to the SELECT-body column.
		const sql = 'select\n    a\n        + b\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('VAR',    11, 11, 1, 5),
			sqlTok('PLUS',   20, 20, 2, 9),
			sqlTok('VAR',    22, 22, 2, 11),
			sqlTok('FROM',   24, 27, 3, 4),
			sqlTok('VAR',    29, 29, 3, 6),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('does not flag SLASH / MINUS / DASH / STAR / MOD continuation lines', () => {
		// Each test uses the smallest possible SELECT body with the operator
		// leading the continuation. Engine should ignore the operator-led line.
		for (const opType of ['SLASH', 'MINUS', 'DASH', 'STAR', 'MOD', 'PERCENT', 'POW', 'DPIPE']) {
			const sql = `select\n    a\n        ${opType[0]} b\nfrom t`;
			const toks: SqlToken[] = [
				sqlTok('SELECT', 0,  5, 0, 6),
				sqlTok('VAR',   11, 11, 1, 5),
				sqlTok(opType,  20, 20, 2, 9),
				sqlTok('VAR',   22, 22, 2, 11),
				sqlTok('FROM',  24, 27, 3, 4),
				sqlTok('VAR',   29, 29, 3, 6),
			];
			expect(check(sql, toks), `expected no violation for ${opType} continuation`).toHaveLength(0);
		}
	});

	it('autofix indents column to match expected', () => {
		const sql = 'select\na\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('VAR',    7,  7, 1, 1),
			sqlTok('FROM',   9, 12, 2, 4),
			sqlTok('VAR',   14, 14, 2, 6),
		];
		const v = check(sql, toks);
		const fixed = applyEditsToText(sql, (v[0].action as FixAction).ops);
		expect(fixed.split('\n')[1]).toBe('    a');
	});

	// ── FROM body ──────────────────────────────────────────────────────────

	it('flags table at col 0 under FROM at col 0', () => {
		// select *
		// from
		// t
		const sql = 'select *\nfrom\nt';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 1, 4),
			sqlTok('VAR',    14, 14, 2, 1),
		];
		const v = check(sql, toks);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('under \'from\'');
	});

	// ── WHERE body ─────────────────────────────────────────────────────────

	it('flags condition continuation at col 0 under WHERE at col 0', () => {
		// select * from t
		// where a = 1
		// and b = 2        ← AND skipped as anchor; b on same line, but here b is NOT first
		// Actually "and b = 2" starts with AND; first SQL token on that line is AND (skipped).
		// Use a case where a token that ISN'T an operator is first on line.
		// select * from t
		// where
		// x = 1
		const sql = 'select * from t\nwhere\nx = 1';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 0, 13),
			sqlTok('VAR',    14, 14, 0, 15),
			sqlTok('WHERE',  16, 20, 1, 5),
			sqlTok('VAR',    22, 22, 2, 1),   // 'x' at col 0
			sqlTok('EQ',     24, 24, 2, 3),
			sqlTok('NUMBER', 26, 26, 2, 5),
		];
		const v = check(sql, toks);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('under \'where\'');
	});

	// ── Skip set verifications ─────────────────────────────────────────────

	it('does not flag JOIN first-on-line (owned by indent-joins)', () => {
		const sql = 'select *\nfrom t\njoin other on t.id = other.id';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 1, 4),
			sqlTok('VAR',    14, 14, 1, 6),
			sqlTok('JOIN',   16, 19, 2, 4),   // first on line — should not be flagged
			sqlTok('VAR',    21, 25, 2, 10),
			sqlTok('ON',     27, 28, 2, 13),
			sqlTok('VAR',    30, 30, 2, 15),
			sqlTok('DOT',    31, 31, 2, 16),
			sqlTok('VAR',    32, 33, 2, 18),
			sqlTok('EQ',     35, 35, 2, 20),
			sqlTok('VAR',    37, 41, 2, 26),
			sqlTok('DOT',    42, 42, 2, 27),
			sqlTok('VAR',    43, 44, 2, 29),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('does not flag AND continuation (owned by operator-position)', () => {
		// select * from t where a = 1
		// and b = 2
		const sql = 'select * from t where a = 1\nand b = 2';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 0, 13),
			sqlTok('VAR',    14, 14, 0, 15),
			sqlTok('WHERE',  16, 20, 0, 21),
			sqlTok('VAR',    22, 22, 0, 23),
			sqlTok('EQ',     24, 24, 0, 25),
			sqlTok('NUMBER', 26, 26, 0, 27),
			sqlTok('AND',    28, 30, 1, 3),  // first on line — skipped
			sqlTok('VAR',    32, 32, 1, 5),  // 'b' on same line as AND, not first
			sqlTok('EQ',     34, 34, 1, 7),
			sqlTok('NUMBER', 36, 36, 1, 9),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('does not flag SELECT itself (owned by peer rules)', () => {
		// with foo as (
		//     select *
		// )
		// select *
		// from foo
		const sql = 'with foo as (\nselect *\n)\nselect *\nfrom foo';
		const toks: SqlToken[] = [
			sqlTok('WITH',     0,  3, 0, 4),
			sqlTok('VAR',      5,  7, 0, 8),
			sqlTok('AS',       9, 10, 0, 11),
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('SELECT',  14, 19, 1, 6),   // col 0, inside paren, first on line
			sqlTok('STAR',    21, 21, 1, 8),
			sqlTok('R_PAREN', 23, 23, 2, 1),
			sqlTok('SELECT',  25, 30, 3, 6),
			sqlTok('STAR',    32, 32, 3, 8),
			sqlTok('FROM',    34, 37, 4, 4),
			sqlTok('VAR',     39, 41, 4, 8),
		];
		// SELECT inside paren is first on line but skipped; no governor yet; no flag.
		// Inner SELECT *sets* the clause at that depth; after R_PAREN we pop.
		// Outer SELECT is first on line (no governor at top yet), skipped.
		expect(check(sql, toks)).toHaveLength(0);
	});

	// ── Paren scope ────────────────────────────────────────────────────────

	it('popping on R_PAREN restores outer clause context', () => {
		// select
		//     (select count(*) from t) as n
		// from x
		// where
		// y
		// The outer WHERE body 'y' should be flagged (col 0 → col 4).
		const sql = 'select\n    (select count(*) from t) as n\nfrom x\nwhere\ny';
		const toks: SqlToken[] = [
			sqlTok('SELECT',   0,  5, 0, 6),
			sqlTok('L_PAREN', 11, 11, 1, 5),
			sqlTok('SELECT',  12, 17, 1, 11),
			sqlTok('VAR',     19, 23, 1, 17),
			sqlTok('L_PAREN', 24, 24, 1, 18),
			sqlTok('STAR',    25, 25, 1, 19),
			sqlTok('R_PAREN', 26, 26, 1, 20),
			sqlTok('FROM',    28, 31, 1, 25),
			sqlTok('VAR',     33, 33, 1, 27),
			sqlTok('R_PAREN', 34, 34, 1, 28),
			sqlTok('AS',      36, 37, 1, 31),
			sqlTok('VAR',     39, 39, 1, 33),
			sqlTok('FROM',    41, 44, 2, 4),
			sqlTok('VAR',     46, 46, 2, 6),
			sqlTok('WHERE',   48, 52, 3, 5),
			sqlTok('VAR',     54, 54, 4, 1),   // 'y' at col 0 — should be col 4 under WHERE
		];
		const v = check(sql, toks);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('under \'where\'');
	});

	// ── CASE body is intentionally NOT flagged (out of scope for Phase 1) ──

	it('does not flag WHEN/ELSE/END (CASE body — owned by future rule)', () => {
		// select
		//     case
		// when x then 1        ← WHEN first-on-line, skipped
		// when y then 2
		// else 3
		// end as col
		// from t
		const sql = 'select\n    case\nwhen x then 1\nwhen y then 2\nelse 3\nend as col\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('CASE',   11, 14, 1, 9),
			sqlTok('WHEN',   16, 19, 2, 5),
			sqlTok('VAR',    21, 21, 2, 7),
			sqlTok('THEN',   23, 26, 2, 12),
			sqlTok('NUMBER', 28, 28, 2, 14),
			sqlTok('WHEN',   30, 33, 3, 5),
			sqlTok('VAR',    35, 35, 3, 7),
			sqlTok('THEN',   37, 40, 3, 12),
			sqlTok('NUMBER', 42, 42, 3, 14),
			sqlTok('ELSE',   44, 47, 4, 5),
			sqlTok('NUMBER', 49, 49, 4, 7),
			sqlTok('END',    51, 53, 5, 4),
			sqlTok('AS',     55, 56, 5, 7),
			sqlTok('VAR',    58, 60, 5, 11),
			sqlTok('FROM',   62, 65, 6, 4),
			sqlTok('VAR',    67, 67, 6, 6),
		];
		// CASE itself IS flagged (body of SELECT) — that's correct, CASE at col 4 is body-indent.
		// But the actual input already has CASE at col 4 (expected for SELECT body), so no flag for CASE.
		// WHEN/ELSE/END are all first-on-line but in SKIP_ANCHOR_TYPES.
		const v = check(sql, toks);
		expect(v.every(e => !e.message.includes('under \'select\'') || e.range.start.line > 0)).toBe(true);
		// Specifically: none of WHEN/ELSE/END lines are flagged.
		const flaggedLines = v.map(e => e.range.start.line);
		expect(flaggedLines).not.toContain(2); // when x
		expect(flaggedLines).not.toContain(3); // when y
		expect(flaggedLines).not.toContain(4); // else 3
		expect(flaggedLines).not.toContain(5); // end as col
	});

	// ── No-op cases ────────────────────────────────────────────────────────

	it('no violations when there are no sqlTokens', () => {
		const doc = mockDocument('select\na\nfrom t');
		const m = model({});
		expect(indentBodyRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('no violations when no clause is in scope yet', () => {
		// just WITH + CTE name before any SELECT — no governor exists
		const sql = 'with\nbase as (select * from t)';
		const toks: SqlToken[] = [
			sqlTok('WITH',     0,  3, 0, 4),
			sqlTok('VAR',      5,  8, 1, 4),    // 'base' at col 0, no governor
			sqlTok('AS',      10, 11, 1, 7),
			sqlTok('L_PAREN', 13, 13, 1, 9),
			sqlTok('SELECT',  14, 19, 1, 15),
			sqlTok('STAR',    21, 21, 1, 17),
			sqlTok('FROM',    23, 26, 1, 22),
			sqlTok('VAR',     28, 28, 1, 24),
			sqlTok('R_PAREN', 29, 29, 1, 25),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});
});
