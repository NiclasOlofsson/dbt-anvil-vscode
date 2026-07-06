import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { subqueryToCteRule } from '../../ninja/rules/structure-subquery-to-cte';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.structure.subquery-to-cte';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return subqueryToCteRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags subquery in FROM clause', () => {
		// SELECT * FROM (SELECT id FROM t) AS sub
		const sql = 'SELECT * FROM (SELECT id FROM t) AS sub';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('L_PAREN', 14, 14, 0, 15),
			sqlTok('SELECT', 15, 20, 0, 21),
			sqlTok('VAR', 22, 23, 0, 24),
			sqlTok('FROM', 25, 28, 0, 29),
			sqlTok('VAR', 30, 30, 0, 31),
			sqlTok('R_PAREN', 31, 31, 0, 32),
			sqlTok('VAR', 33, 34, 0, 35),
			sqlTok('VAR', 36, 38, 0, 39),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('CTE');
	});

	it('flags subquery in JOIN clause', () => {
		// SELECT * FROM t JOIN (SELECT id FROM u) AS sub ON t.id = sub.id
		const sql = 'SELECT * FROM t JOIN (SELECT id FROM u) AS sub ON t.id = sub.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('L_PAREN', 21, 21, 0, 22),
			sqlTok('SELECT', 22, 27, 0, 28),
			sqlTok('VAR', 29, 30, 0, 31),
			sqlTok('FROM', 32, 35, 0, 36),
			sqlTok('VAR', 37, 37, 0, 38),
			sqlTok('R_PAREN', 38, 38, 0, 39),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
	});

	it('no violation for plain table reference after FROM', () => {
		// SELECT * FROM orders
		const sql = 'SELECT * FROM orders';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 19, 0, 20),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for plain table reference after JOIN', () => {
		// SELECT * FROM t JOIN u ON t.id = u.id
		const sql = 'SELECT * FROM t JOIN u ON t.id = u.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag L_PAREN inside a CTE body (depth > 0)', () => {
		// WITH cte AS (SELECT id FROM (SELECT id FROM t) sub) SELECT * FROM cte
		// The inner FROM (SELECT...) is inside the CTE parens, so depth > 0 when
		// we encounter that FROM token — it should not be flagged.
		const sql = 'WITH cte AS (SELECT id FROM (SELECT id FROM t) sub) SELECT * FROM cte';
		const tokens: SqlToken[] = [
			sqlTok('WITH', 0, 3, 0, 4),
			sqlTok('VAR', 5, 7, 0, 8),
			sqlTok('AS', 9, 10, 0, 11),
			sqlTok('L_PAREN', 12, 12, 0, 13),       // CTE body open — depth becomes 1
			sqlTok('SELECT', 13, 18, 0, 19),
			sqlTok('VAR', 20, 21, 0, 22),
			sqlTok('FROM', 23, 26, 0, 27),           // depth 1 — should NOT trigger
			sqlTok('L_PAREN', 28, 28, 0, 29),        // depth becomes 2
			sqlTok('SELECT', 29, 34, 0, 35),
			sqlTok('VAR', 36, 37, 0, 38),
			sqlTok('FROM', 39, 42, 0, 43),
			sqlTok('VAR', 44, 44, 0, 45),
			sqlTok('R_PAREN', 45, 45, 0, 46),        // back to depth 1
			sqlTok('VAR', 47, 49, 0, 50),
			sqlTok('R_PAREN', 50, 50, 0, 51),        // back to depth 0
			sqlTok('SELECT', 52, 57, 0, 58),
			sqlTok('STAR', 59, 59, 0, 60),
			sqlTok('FROM', 61, 64, 0, 65),           // depth 0 — FROM plain table
			sqlTok('VAR', 66, 68, 0, 69),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('SELECT 1');
		const m = model({});
		expect(subqueryToCteRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
