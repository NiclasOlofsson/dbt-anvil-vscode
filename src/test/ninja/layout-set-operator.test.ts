import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { setOperatorRule } from '../../ninja/rules/layout-set-operator';
import type { SqlToken } from '../../ftl/sql-tokens';
import { FixAction } from '../../ninja/violation';

/**
 * SqlToken.col represents the 1-based end column (equivalent to 0-based
 * exclusive end column). `tokenStartCol(tok)` recovers the start by
 * `tok.col - (tok.end - tok.start + 1)`. All fixtures below use END col.
 */

const RULE = 'ninja.layout.set-operator';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return setOperatorRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── UNION alone on its line ──────────────────────────────────────────────
	it('no violation when UNION is alone on its own line', () => {
		// line 0: 'select 1'  line 1: 'union'  line 2: 'select 2'
		const sql = 'select 1\nunion\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('NUMBER', 7,  7, 0, 8),
			sqlTok('UNION',  9, 13, 1, 5),
			sqlTok('SELECT', 15, 20, 2, 6),
			sqlTok('NUMBER', 22, 22, 2, 8),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags UNION when content precedes it on the same line', () => {
		const sql = 'select 1 union\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('NUMBER', 7,  7, 0, 8),
			sqlTok('UNION',  9, 13, 0, 14),
			sqlTok('SELECT', 15, 20, 1, 6),
			sqlTok('NUMBER', 22, 22, 1, 8),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION when content follows it on the same line', () => {
		const sql = 'select 1\nunion select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('NUMBER', 7,  7, 0, 8),
			sqlTok('UNION',  9, 13, 1, 5),
			sqlTok('SELECT', 15, 20, 1, 11),
			sqlTok('NUMBER', 22, 22, 1, 13),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION when entirely inline', () => {
		const sql = 'select 1 union select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('NUMBER', 7,  7, 0, 8),
			sqlTok('UNION',  9, 13, 0, 14),
			sqlTok('SELECT', 15, 20, 0, 21),
			sqlTok('NUMBER', 22, 22, 0, 23),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	// ── UNION ALL ────────────────────────────────────────────────────────────
	it('no violation when UNION ALL is alone on its own line', () => {
		// The lexer emits 'union all' as a single UNION_ALL token
		const sql = 'select 1\nunion all\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 1, 9),
			sqlTok('SELECT',   19, 24, 2, 6),
			sqlTok('NUMBER',   26, 26, 2, 8),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags UNION ALL when content precedes it on the same line', () => {
		const sql = 'select 1 union all\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 0, 18),
			sqlTok('SELECT',   19, 24, 1, 6),
			sqlTok('NUMBER',   26, 26, 1, 8),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION ALL when content follows it on the same line', () => {
		const sql = 'select 1\nunion all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 1, 9),
			sqlTok('SELECT',   19, 24, 1, 16),
			sqlTok('NUMBER',   26, 26, 1, 18),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION ALL when entirely inline', () => {
		const sql = 'select 1 union all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 0, 18),
			sqlTok('SELECT',   19, 24, 0, 25),
			sqlTok('NUMBER',   26, 26, 0, 27),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	// ── INTERSECT / EXCEPT ──────────────────────────────────────────────────
	it('no violation when INTERSECT is alone on its own line', () => {
		const sql = 'select 1\nintersect\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('INTERSECT', 9, 17, 1, 9),
			sqlTok('SELECT',   19, 24, 2, 6),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags INTERSECT when inline', () => {
		const sql = 'select 1 intersect select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('INTERSECT', 9, 17, 0, 18),
			sqlTok('SELECT',   19, 24, 0, 25),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('no violation when EXCEPT is alone on its own line', () => {
		const sql = 'select 1\nexcept\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('NUMBER', 7,  7, 0, 8),
			sqlTok('EXCEPT', 9, 14, 1, 6),
			sqlTok('SELECT', 16, 21, 2, 6),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags EXCEPT when inline', () => {
		const sql = 'select 1 except select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 6),
			sqlTok('NUMBER', 7,  7, 0, 8),
			sqlTok('EXCEPT', 9, 14, 0, 15),
			sqlTok('SELECT', 16, 21, 0, 22),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	// ── Multiple operators ──────────────────────────────────────────────────
	it('flags each inline UNION ALL independently in a chained query', () => {
		const sql = 'select 1 union all select 2 union all select 3\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 0, 18),
			sqlTok('SELECT',   19, 24, 0, 25),
			sqlTok('NUMBER',   26, 26, 0, 27),
			sqlTok('UNION_ALL', 28, 36, 0, 37),
			sqlTok('SELECT',   38, 43, 0, 44),
			sqlTok('NUMBER',   45, 45, 0, 46),
		];
		expect(check(sql, toks)).toHaveLength(2);
	});

	// ── Autofix ─────────────────────────────────────────────────────────────
	it('violation carries a fix action', () => {
		const sql = 'select 1 union all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 0, 18),
			sqlTok('SELECT',   19, 24, 0, 25),
			sqlTok('NUMBER',   26, 26, 0, 27),
		];
		const v = check(sql, toks);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).type).toBe('fix');
	});

	it('fix for inline UNION ALL places it alone on its own line', () => {
		const sql = 'select 1 union all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 6),
			sqlTok('NUMBER',    7,  7, 0, 8),
			sqlTok('UNION_ALL', 9, 17, 0, 18),
			sqlTok('SELECT',   19, 24, 0, 25),
			sqlTok('NUMBER',   26, 26, 0, 27),
		];
		const v = check(sql, toks);
		const action = v[0].action as FixAction;
		const fixed = applyEditsToText(sql, action.ops);
		const lines = fixed.split('\n');
		const unionLine = lines.findIndex(l => /union all/i.test(l));
		expect(unionLine).toBeGreaterThanOrEqual(0);
		expect(lines[unionLine].trim()).toBe('union all');
	});
});
