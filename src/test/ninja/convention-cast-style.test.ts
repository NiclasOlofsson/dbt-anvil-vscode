import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { castStyleRule } from '../../ninja/rules/convention-cast-style';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.convention.cast-style';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return castStyleRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation when using CAST(x AS type)', () => {
		//             0         1         2
		//             0123456789012345678901234567
		const sql = 'select cast(a as int) from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('CAST', 7, 10, 0, 11),
			sqlTok('L_PAREN', 11, 11, 0, 12),
			sqlTok('VAR', 12, 12, 0, 13),
			sqlTok('AS', 14, 15, 0, 16),
			sqlTok('INT', 17, 19, 0, 20),
			sqlTok('R_PAREN', 20, 20, 0, 21),
			sqlTok('FROM', 22, 25, 0, 26),
			sqlTok('VAR', 27, 27, 0, 28),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags :: (DCOLON) operator', () => {
		//             0         1
		//             01234567890123456789
		const sql = 'select a::int from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('DCOLON', 8, 9, 0, 10),
			sqlTok('INT', 10, 12, 0, 13),
			sqlTok('FROM', 14, 17, 0, 18),
			sqlTok('VAR', 19, 19, 0, 20),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('CAST(x AS type)');
		expect(v[0].message).toContain('::');
	});

	it('flags multiple DCOLON tokens', () => {
		const sql = 'select a::int, b::text from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('DCOLON', 8, 9, 0, 10),
			sqlTok('INT', 10, 12, 0, 13),
			sqlTok('COMMA', 13, 13, 0, 14),
			sqlTok('VAR', 15, 15, 0, 16),
			sqlTok('DCOLON', 16, 17, 0, 18),
			sqlTok('TEXT', 18, 21, 0, 22),
			sqlTok('FROM', 23, 26, 0, 27),
			sqlTok('VAR', 28, 28, 0, 29),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});

	it('no violation action (detection only, no autofix)', () => {
		const sql = 'select a::int from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('DCOLON', 8, 9, 0, 10),
			sqlTok('INT', 10, 12, 0, 13),
			sqlTok('FROM', 14, 17, 0, 18),
			sqlTok('VAR', 19, 19, 0, 20),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].action).toBeUndefined();
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select a::int from t');
		const m = model({});
		expect(castStyleRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('flags DCOLON in a multi-line query', () => {
		const sql = 'select\n  a::int\nfrom t';
		// offsets: 'select'=0-5 l0, 'a'=9 l1, '::'=10-11 l1, 'int'=12-14 l1, 'from'=16-19 l2
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 9, 9, 1, 2),
			sqlTok('DCOLON', 10, 11, 1, 4),
			sqlTok('INT', 12, 14, 1, 7),
			sqlTok('FROM', 16, 19, 2, 4),
			sqlTok('VAR', 21, 21, 2, 6),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(1);
	});
});
