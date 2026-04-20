import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { setOperatorRule } from '../../ninja/rules/layout-set-operator';
import type { SqlToken } from '../../ftl/parse-result';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.layout.set-operator';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return setOperatorRule.check({ model: m, document: doc, config: cfg() });
}

// ── UNION alone on its line ──────────────────────────────────────────────────

describe(RULE, () => {
	it('no violation when UNION is alone on its own line', () => {
		// select 1\nunion\nselect 2
		// line 0: SELECT(0) NUMBER(7)
		// line 1: UNION(9)
		// line 2: SELECT(15)
		const sql = 'select 1\nunion\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 0),
			sqlTok('NUMBER', 7,  7, 0, 7),
			sqlTok('UNION',  9, 13, 1, 0),
			sqlTok('SELECT', 15, 20, 2, 0),
			sqlTok('NUMBER', 22, 22, 2, 7),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags UNION when content precedes it on the same line', () => {
		// 'select 1 union'  — UNION not alone (content before)
		const sql = 'select 1 union\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 0),
			sqlTok('NUMBER', 7,  7, 0, 7),
			sqlTok('UNION',  9, 13, 0, 9),
			sqlTok('SELECT', 15, 20, 1, 0),
			sqlTok('NUMBER', 22, 22, 1, 7),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION when content follows it on the same line', () => {
		// 'union select 2' — UNION not alone (content after)
		const sql = 'select 1\nunion select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 0),
			sqlTok('NUMBER', 7,  7, 0, 7),
			sqlTok('UNION',  9, 13, 1, 0),
			sqlTok('SELECT', 14, 19, 1, 5),
			sqlTok('NUMBER', 21, 21, 1, 12),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION when entirely inline', () => {
		// 'select 1 union select 2'
		const sql = 'select 1 union select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 0),
			sqlTok('NUMBER', 7,  7, 0, 7),
			sqlTok('UNION',  9, 13, 0, 9),
			sqlTok('SELECT', 15, 20, 0, 15),
			sqlTok('NUMBER', 22, 22, 0, 22),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	// ── UNION ALL ──────────────────────────────────────────────────────────────

	it('no violation when UNION ALL is alone on its own line', () => {
		// sqlglot emits 'union all' as a single UNION_ALL token
		// select 1\nunion all\nselect 2
		const sql = 'select 1\nunion all\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('UNION_ALL', 9, 17, 1, 0),
			sqlTok('SELECT',   19, 24, 2, 0),
			sqlTok('NUMBER',   26, 26, 2, 7),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags UNION ALL when content precedes it on the same line', () => {
		const sql = 'select 1 union all\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('UNION_ALL', 9, 17, 0, 9),
			sqlTok('SELECT',   19, 24, 1, 0),
			sqlTok('NUMBER',   26, 26, 1, 7),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION ALL when content follows it on the same line', () => {
		const sql = 'select 1\nunion all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('UNION_ALL', 9, 17, 1, 0),
			sqlTok('SELECT',   19, 24, 1, 10),
			sqlTok('NUMBER',   26, 26, 1, 17),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('flags UNION ALL when entirely inline', () => {
		const sql = 'select 1 union all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('UNION_ALL', 9, 17, 0, 9),
			sqlTok('SELECT',   19, 24, 0, 19),
			sqlTok('NUMBER',   26, 26, 0, 26),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	// ── INTERSECT / EXCEPT ────────────────────────────────────────────────────

	it('no violation when INTERSECT is alone on its own line', () => {
		const sql = 'select 1\nintersect\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('INTERSECT', 9, 17, 1, 0),
			sqlTok('SELECT',   19, 24, 2, 0),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags INTERSECT when inline', () => {
		const sql = 'select 1 intersect select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('INTERSECT', 9, 17, 0, 9),
			sqlTok('SELECT',   19, 24, 0, 19),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	it('no violation when EXCEPT is alone on its own line', () => {
		const sql = 'select 1\nexcept\nselect 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 0),
			sqlTok('NUMBER', 7,  7, 0, 7),
			sqlTok('EXCEPT', 9, 14, 1, 0),
			sqlTok('SELECT', 16, 21, 2, 0),
		];
		expect(check(sql, toks)).toHaveLength(0);
	});

	it('flags EXCEPT when inline', () => {
		const sql = 'select 1 except select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0,  5, 0, 0),
			sqlTok('NUMBER', 7,  7, 0, 7),
			sqlTok('EXCEPT', 9, 14, 0, 9),
			sqlTok('SELECT', 16, 21, 0, 16),
		];
		expect(check(sql, toks)).toHaveLength(1);
	});

	// ── Multiple operators ────────────────────────────────────────────────────

	it('flags each inline UNION ALL independently in a chained query', () => {
		// 'select 1 union all select 2 union all select 3'
		const sql = 'select 1 union all select 2 union all select 3\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('UNION_ALL', 9, 17, 0, 9),
			sqlTok('SELECT',   19, 24, 0, 19),
			sqlTok('NUMBER',   26, 26, 0, 26),
			sqlTok('UNION_ALL', 28, 36, 0, 28),
			sqlTok('SELECT',   38, 43, 0, 38),
			sqlTok('NUMBER',   45, 45, 0, 45),
		];
		expect(check(sql, toks)).toHaveLength(2);
	});

	// ── Autofix ───────────────────────────────────────────────────────────────

	it('violation carries a fix action', () => {
		const sql = 'select 1 union all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('UNION_ALL', 9, 17, 0, 9),
			sqlTok('SELECT',   19, 24, 0, 19),
			sqlTok('NUMBER',   26, 26, 0, 26),
		];
		const v = check(sql, toks);
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).type).toBe('fix');
	});

	it('fix for inline UNION ALL places it alone on its own line', () => {
		const sql = 'select 1 union all select 2\n';
		const toks: SqlToken[] = [
			sqlTok('SELECT',    0,  5, 0, 0),
			sqlTok('NUMBER',    7,  7, 0, 7),
			sqlTok('UNION_ALL', 9, 17, 0, 9),
			sqlTok('SELECT',   19, 24, 0, 19),
			sqlTok('NUMBER',   26, 26, 0, 26),
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
