import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { onVsUsingRule } from '../../ninja/rules/structure-on-vs-using';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.structure.on-vs-using';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return onVsUsingRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags USING keyword', () => {
		// SELECT * FROM t JOIN u USING (id)
		const sql = 'SELECT * FROM t JOIN u USING (id)';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
			sqlTok('USING', 23, 27, 0, 28),
			sqlTok('L_PAREN', 29, 29, 0, 30),
			sqlTok('VAR', 30, 31, 0, 32),
			sqlTok('R_PAREN', 32, 32, 0, 33),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('ON');
	});

	it('flags multiple USING keywords', () => {
		// SELECT * FROM t JOIN u USING (id) JOIN v USING (code)
		const sql = 'SELECT * FROM t JOIN u USING (id) JOIN v USING (code)';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
			sqlTok('USING', 23, 27, 0, 28),
			sqlTok('L_PAREN', 29, 29, 0, 30),
			sqlTok('VAR', 30, 31, 0, 32),
			sqlTok('R_PAREN', 32, 32, 0, 33),
			sqlTok('JOIN', 34, 37, 0, 38),
			sqlTok('VAR', 39, 39, 0, 40),
			sqlTok('USING', 41, 45, 0, 46),
			sqlTok('L_PAREN', 47, 47, 0, 48),
			sqlTok('VAR', 48, 51, 0, 52),
			sqlTok('R_PAREN', 52, 52, 0, 53),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
		expect(v.every(vi => vi.rule === RULE)).toBe(true);
	});

	it('no violation when JOIN uses ON', () => {
		// SELECT * FROM t JOIN u ON t.id = u.id
		const sql = 'SELECT * FROM t JOIN u ON t.id = u.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
			sqlTok('ON', 23, 24, 0, 25),
			sqlTok('VAR', 26, 26, 0, 27),
			sqlTok('DOT', 27, 27, 0, 28),
			sqlTok('VAR', 28, 29, 0, 30),
			sqlTok('EQ', 31, 31, 0, 32),
			sqlTok('VAR', 33, 33, 0, 34),
			sqlTok('DOT', 34, 34, 0, 35),
			sqlTok('VAR', 35, 36, 0, 37),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for query with no JOIN', () => {
		const sql = 'SELECT id FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),
			sqlTok('FROM', 10, 13, 0, 14),
			sqlTok('VAR', 15, 15, 0, 16),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('SELECT 1');
		const m = model({});
		expect(onVsUsingRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
