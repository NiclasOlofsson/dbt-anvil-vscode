import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { joinWithoutOnRule } from '../../ninja/rules/ambiguity-join-without-on';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.ambiguity.join-without-on';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return joinWithoutOnRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags INNER JOIN without ON', () => {
		const sql = 'select * from a inner join b';
		const tokens: SqlToken[] = [
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('INNER', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('ON or USING');
	});

	it('no violation for INNER JOIN with ON', () => {
		const sql = 'select * from a inner join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('INNER', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('ON', 27, 28, 0, 29),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for INNER JOIN with USING', () => {
		const sql = 'select * from a inner join b using (id)';
		const tokens: SqlToken[] = [
			sqlTok('INNER', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('USING', 27, 31, 0, 32),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for CROSS JOIN without ON', () => {
		const sql = 'select * from a cross join b';
		const tokens: SqlToken[] = [
			sqlTok('CROSS', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags LEFT JOIN without ON', () => {
		const sql = 'select * from a left join b';
		const tokens: SqlToken[] = [
			sqlTok('LEFT', 14, 17, 0, 18),
			sqlTok('JOIN', 19, 22, 0, 23),
			sqlTok('IDENTIFIER', 23, 23, 0, 24),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('flags RIGHT JOIN without ON', () => {
		const sql = 'select * from a right join b';
		const tokens: SqlToken[] = [
			sqlTok('RIGHT', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('IDENTIFIER', 24, 24, 0, 25),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('flags FULL JOIN without ON', () => {
		const sql = 'select * from a full join b';
		const tokens: SqlToken[] = [
			sqlTok('FULL', 14, 17, 0, 18),
			sqlTok('JOIN', 19, 22, 0, 23),
			sqlTok('IDENTIFIER', 23, 23, 0, 24),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('flags multiple JOINs missing ON', () => {
		const sql = 'select * from a inner join b inner join c';
		const tokens: SqlToken[] = [
			sqlTok('INNER', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('INNER', 27, 31, 0, 32),
			sqlTok('JOIN', 33, 36, 0, 37),
			sqlTok('IDENTIFIER', 38, 38, 0, 39),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});

	it('flags first JOIN only when second has ON', () => {
		const sql = 'select * from a inner join b inner join c on b.id = c.id';
		const tokens: SqlToken[] = [
			sqlTok('INNER', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('INNER', 27, 31, 0, 32),
			sqlTok('JOIN', 33, 36, 0, 37),
			sqlTok('IDENTIFIER', 38, 38, 0, 39),
			sqlTok('ON', 40, 41, 0, 42),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('does not flag ON inside parens as a false positive — ON inside subquery is ignored', () => {
		// JOIN body contains a subquery with ON inside — the rule should not be tricked
		const sql = 'select * from a inner join (select * from b on 1=1) sub';
		const tokens: SqlToken[] = [
			sqlTok('INNER', 14, 18, 0, 19),
			sqlTok('JOIN', 20, 23, 0, 24),
			sqlTok('LPAREN', 25, 25, 0, 26),
			sqlTok('SELECT', 26, 31, 0, 32),
			sqlTok('STAR', 33, 33, 0, 34),
			sqlTok('FROM', 35, 38, 0, 39),
			sqlTok('IDENTIFIER', 40, 40, 0, 41),
			sqlTok('ON', 42, 43, 0, 44),
			sqlTok('RPAREN', 47, 47, 0, 48),
			sqlTok('IDENTIFIER', 49, 51, 0, 52),
		];
		// ON is inside parens — depth > 0 — so rule should flag this as missing ON at depth 0
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select * from a inner join b');
		const m = model({});
		expect(joinWithoutOnRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
