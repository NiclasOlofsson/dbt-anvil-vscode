import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { starWithSetOpRule } from '../../ninja/rules/ambiguity-star-with-setop';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.ambiguity.star-with-setop';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return starWithSetOpRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags SELECT * with UNION', () => {
		const sql = 'select * from a union all select * from b';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('UNION', 16, 20, 0, 21),
			sqlTok('ALL', 22, 24, 0, 25),
			sqlTok('SELECT', 26, 31, 0, 32),
			sqlTok('STAR', 33, 33, 0, 34),
			sqlTok('FROM', 35, 38, 0, 39),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('set operations');
	});

	it('flags SELECT * with INTERSECT', () => {
		const sql = 'select * from a intersect select * from b';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('INTERSECT', 16, 24, 0, 25),
			sqlTok('SELECT', 26, 31, 0, 32),
			sqlTok('STAR', 33, 33, 0, 34),
			sqlTok('FROM', 35, 38, 0, 39),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
	});

	it('flags SELECT * with EXCEPT', () => {
		const sql = 'select * from a except select * from b';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('EXCEPT', 16, 21, 0, 22),
			sqlTok('SELECT', 23, 28, 0, 29),
			sqlTok('STAR', 30, 30, 0, 31),
			sqlTok('FROM', 32, 35, 0, 36),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
	});

	it('no violation for SELECT * without set operators', () => {
		const sql = 'select * from a';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation when explicit columns are used with UNION', () => {
		const sql = 'select a, b from t1 union all select a, b from t2';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('IDENTIFIER', 7, 7, 0, 8),
			sqlTok('FROM', 10, 13, 0, 14),
			sqlTok('UNION', 21, 25, 0, 26),
			sqlTok('ALL', 27, 29, 0, 30),
			sqlTok('SELECT', 31, 36, 0, 37),
			sqlTok('IDENTIFIER', 38, 38, 0, 39),
			sqlTok('FROM', 41, 44, 0, 45),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('ignores set operators inside subquery parens', () => {
		// UNION inside parens should not trigger the rule
		const sql = 'select * from (select a from t1 union all select a from t2) sub';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('LPAREN', 14, 14, 0, 15),
			sqlTok('SELECT', 15, 20, 0, 21),
			sqlTok('IDENTIFIER', 22, 22, 0, 23),
			sqlTok('FROM', 24, 27, 0, 28),
			sqlTok('UNION', 31, 35, 0, 36),
			sqlTok('ALL', 37, 39, 0, 40),
			sqlTok('SELECT', 41, 46, 0, 47),
			sqlTok('IDENTIFIER', 48, 48, 0, 49),
			sqlTok('FROM', 50, 53, 0, 54),
			sqlTok('RPAREN', 57, 57, 0, 58),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('only flags SELECT immediately followed by STAR', () => {
		// SELECT DISTINCT * with UNION — the STAR is not immediately after SELECT
		const sql = 'select distinct * from a union all select distinct * from b';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
			sqlTok('STAR', 16, 16, 0, 17),
			sqlTok('FROM', 18, 21, 0, 22),
			sqlTok('UNION', 25, 29, 0, 30),
			sqlTok('ALL', 31, 33, 0, 34),
			sqlTok('SELECT', 35, 40, 0, 41),
			sqlTok('DISTINCT', 42, 49, 0, 50),
			sqlTok('STAR', 51, 51, 0, 52),
			sqlTok('FROM', 53, 56, 0, 57),
		];
		// DISTINCT intervenes, so no violation (rule checks SELECT immediately followed by STAR)
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select * from a union all select * from b');
		const m = model({});
		expect(starWithSetOpRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
