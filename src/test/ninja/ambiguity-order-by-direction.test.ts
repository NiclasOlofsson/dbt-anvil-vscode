import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { orderByDirectionRule } from '../../ninja/rules/ambiguity-order-by-direction';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.ambiguity.order-by-direction';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return orderByDirectionRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags ORDER BY item with no direction', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890
		const sql = 'select a from t order by a';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('ORDER', 16, 20, 0, 21),
			sqlTok('BY', 22, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('ASC/DESC');
	});

	it('no violation when ASC is explicit', () => {
		const sql = 'select a from t order by a asc';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 16, 20, 0, 21),
			sqlTok('BY', 22, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('ASC', 27, 29, 0, 30),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation when DESC is explicit', () => {
		const sql = 'select a from t order by a desc';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 16, 20, 0, 21),
			sqlTok('BY', 22, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('DESC', 27, 30, 0, 31),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation when NULLS keyword present (NULLS FIRST/LAST)', () => {
		const sql = 'select a from t order by a nulls first';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 16, 20, 0, 21),
			sqlTok('BY', 22, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('NULLS', 27, 31, 0, 32),
			sqlTok('IDENTIFIER', 33, 37, 0, 38),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags multiple undirected items in multi-column ORDER BY', () => {
		const sql = 'select a, b from t order by a, b';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 19, 23, 0, 24),
			sqlTok('BY', 25, 26, 0, 27),
			sqlTok('IDENTIFIER', 28, 28, 0, 29),
			sqlTok('COMMA', 29, 29, 0, 30),
			sqlTok('IDENTIFIER', 31, 31, 0, 32),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
	});

	it('flags only undirected items in mixed ORDER BY', () => {
		const sql = 'select a, b from t order by a asc, b';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 19, 23, 0, 24),
			sqlTok('BY', 25, 26, 0, 27),
			sqlTok('IDENTIFIER', 28, 28, 0, 29),
			sqlTok('ASC', 30, 32, 0, 33),
			sqlTok('COMMA', 33, 33, 0, 34),
			sqlTok('IDENTIFIER', 35, 35, 0, 36),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('stops at LIMIT keyword', () => {
		const sql = 'select a from t order by a limit 10';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 16, 20, 0, 21),
			sqlTok('BY', 22, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('LIMIT', 27, 31, 0, 32),
			sqlTok('NUMBER', 33, 34, 0, 35),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('stops at UNION keyword', () => {
		const sql = 'select a from t order by a union all select a from t order by a asc';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 16, 20, 0, 21),
			sqlTok('BY', 22, 23, 0, 24),
			sqlTok('IDENTIFIER', 25, 25, 0, 26),
			sqlTok('UNION', 27, 31, 0, 32),
			sqlTok('ALL', 33, 35, 0, 36),
			sqlTok('ORDER', 44, 48, 0, 49),
			sqlTok('BY', 50, 51, 0, 52),
			sqlTok('IDENTIFIER', 52, 52, 0, 53),
			sqlTok('ASC', 54, 56, 0, 57),
		];
		// First ORDER BY is undirected → 1 violation; second has ASC → 0
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('does not flag ORDER keyword not followed by BY', () => {
		const sql = 'select a from t where order_num = 1';
		const tokens: SqlToken[] = [
			sqlTok('ORDER', 22, 26, 0, 27),
			sqlTok('IDENTIFIER', 28, 34, 0, 35),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select a order by a');
		const m = model({});
		expect(orderByDirectionRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
