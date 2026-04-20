import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { indentBracketRule } from '../../ninja/rules/layout-indent-bracket';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/parse-result';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return indentBracketRule.check({ model: m, document: doc, config: cfg() });
}

describe('ninja.layout.indent-bracket', () => {
	it('flags SELECT at col 0 inside a CTE body paren opened at col 0', () => {
		// with base as (
		// select *
		// from t
		// )
		const sql = 'with base as (\nselect *\nfrom t\n)';
		const toks: SqlToken[] = [
			sqlTok('WITH',     0,  3, 0, 4),
			sqlTok('VAR',      5,  8, 0, 9),
			sqlTok('AS',      10, 11, 0, 12),
			sqlTok('L_PAREN', 13, 13, 0, 14),
			sqlTok('SELECT',  15, 20, 1, 6),   // col 0 — should be col 4
			sqlTok('STAR',    22, 22, 1, 8),
			sqlTok('FROM',    24, 27, 2, 4),
			sqlTok('VAR',     29, 29, 2, 6),
			sqlTok('R_PAREN', 31, 31, 3, 1),
		];
		const v = check(sql, toks);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe('ninja.layout.indent-bracket');
		expect(v[0].message).toContain('column 4');
		expect(v[0].message).toContain('column 0');
	});

	it('no violation when SELECT inside paren is already at col 4', () => {
		// with base as (
		//     select *
		// )
		const sql = 'with base as (\n    select *\n)';
		const toks: SqlToken[] = [
			sqlTok('WITH',     0,  3, 0, 4),
			sqlTok('VAR',      5,  8, 0, 9),
			sqlTok('AS',      10, 11, 0, 12),
			sqlTok('L_PAREN', 13, 13, 0, 14),
			sqlTok('SELECT',  19, 24, 1, 10),  // start col 10-6=4
			sqlTok('STAR',    26, 26, 1, 12),
			sqlTok('R_PAREN', 28, 28, 2, 1),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('does not flag content inside parens on the same line as `(`', () => {
		const sql = '(select * from t)';
		const toks: SqlToken[] = [
			sqlTok('L_PAREN',  0,  0, 0, 1),
			sqlTok('SELECT',   1,  6, 0, 7),
			sqlTok('STAR',     8,  8, 0, 9),
			sqlTok('FROM',    10, 13, 0, 14),
			sqlTok('VAR',     15, 15, 0, 16),
			sqlTok('R_PAREN', 16, 16, 0, 17),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags multi-line function args at col 0 (`coalesce(\\n a,\\n b\\n)`)', () => {
		// coalesce(
		// a,
		// b
		// )
		const sql = 'coalesce(\na,\nb\n)';
		const toks: SqlToken[] = [
			sqlTok('VAR',      0,  7, 0, 8),    // coalesce
			sqlTok('L_PAREN',  8,  8, 0, 9),
			sqlTok('VAR',     10, 10, 1, 1),    // a, col 0 — should be col 4
			sqlTok('COMMA',   11, 11, 1, 2),
			sqlTok('VAR',     13, 13, 2, 1),    // b, col 0 — should be col 4
			sqlTok('R_PAREN', 15, 15, 3, 1),
		];
		const v = check(sql, toks);
		expect(v).toHaveLength(2);
	});

	it('hands off to indent-body once a clause keyword is seen', () => {
		// Inside a paren, after SELECT, body tokens are owned by indent-body.
		// The bracket rule should NOT fire on `a` / `b` following SELECT.
		// (
		//     select
		//     a,
		//     b
		//     from t
		// )
		const sql = '(\n    select\n    a,\n    b\n    from t\n)';
		const toks: SqlToken[] = [
			sqlTok('L_PAREN',  0,  0, 0, 1),
			sqlTok('SELECT',   6, 11, 1, 10),   // col 4
			sqlTok('VAR',     17, 17, 2, 5),    // 'a' col 4 — after SELECT, bracket rule skips
			sqlTok('COMMA',   18, 18, 2, 6),
			sqlTok('VAR',     24, 24, 3, 5),    // 'b' col 4
			sqlTok('FROM',    30, 33, 4, 8),    // 'from' col 4
			sqlTok('VAR',     35, 35, 4, 10),
			sqlTok('R_PAREN', 37, 37, 5, 1),
		];
		// SELECT itself is at col 4 (expected). `a` and `b` are first-on-line but
		// clauseSeen=true by then, so bracket rule skips them. Only indent-body
		// cares about `a`/`b` — it's not in this rule's responsibility.
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('nested parens push/pop correctly', () => {
		// ( (
		//     select *
		// ) )
		// Each paren pushes a fresh scope; inner SELECT anchors to inner paren line.
		// Outer `(` col 0 → inner `(` on same line col 2. Inner paren anchor = col 0
		// (first-on-line on row 0 is outer `(`).
		// Inner SELECT expected = 0 + 4 = 4.
		const sql = '( (\n    select *\n) )';
		const toks: SqlToken[] = [
			sqlTok('L_PAREN',  0,  0, 0, 1),
			sqlTok('L_PAREN',  2,  2, 0, 3),
			sqlTok('SELECT',   8, 13, 1, 10),   // col 4 — matches expected
			sqlTok('STAR',    15, 15, 1, 12),
			sqlTok('R_PAREN', 17, 17, 2, 1),
			sqlTok('R_PAREN', 19, 19, 2, 3),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('autofix replaces leading whitespace to bracket-body indent', () => {
		const sql = 'with base as (\nselect *\n)';
		const toks: SqlToken[] = [
			sqlTok('WITH',     0,  3, 0, 4),
			sqlTok('VAR',      5,  8, 0, 9),
			sqlTok('AS',      10, 11, 0, 12),
			sqlTok('L_PAREN', 13, 13, 0, 14),
			sqlTok('SELECT',  15, 20, 1, 6),   // col 0
			sqlTok('STAR',    22, 22, 1, 8),
			sqlTok('R_PAREN', 24, 24, 2, 1),
		];
		const v = check(sql, toks);
		expect(v).toHaveLength(1);
		const fixed = applyEditsToText(sql, (v[0].action as FixAction).ops);
		expect(fixed.split('\n')[1]).toBe('    select *');
	});

	it('nothing at top level is checked', () => {
		const sql = 'select *\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT',  0,  5, 0, 6),
			sqlTok('STAR',    7,  7, 0, 8),
			sqlTok('FROM',    9, 12, 1, 4),
			sqlTok('VAR',    14, 14, 1, 6),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('(\nselect *\n)');
		const m = model({});
		expect(indentBracketRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
