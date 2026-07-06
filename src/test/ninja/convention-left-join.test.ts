import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { leftJoinRule } from '../../ninja/rules/convention-left-join';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.convention.left-join';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return leftJoinRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags RIGHT JOIN', () => {
		const sql = 'select * from a right join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('RIGHT', 16, 20, 0, 21),
			sqlTok('JOIN', 22, 25, 0, 26),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('LEFT JOIN');
		expect(v[0].action).toBeUndefined();
	});

	it('no violation for LEFT JOIN', () => {
		const sql = 'select * from a left join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('LEFT', 16, 19, 0, 20),
			sqlTok('JOIN', 21, 24, 0, 25),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for INNER JOIN', () => {
		const sql = 'select * from a inner join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('INNER', 16, 20, 0, 21),
			sqlTok('JOIN', 22, 25, 0, 26),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('RIGHT not followed by JOIN is not flagged', () => {
		const sql = 'select right(name, 3) from t';
		const tokens: SqlToken[] = [
			sqlTok('RIGHT', 7, 11, 0, 12),
			sqlTok('L_PAREN', 12, 12, 0, 13),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(leftJoinRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
