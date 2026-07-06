import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { columnOrderRule } from '../../ninja/rules/structure-column-order';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.structure.column-order';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return columnOrderRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags STAR after a named column', () => {
		// SELECT id, * FROM t
		const sql = 'SELECT id, * FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),
			sqlTok('COMMA', 9, 9, 0, 10),
			sqlTok('STAR', 11, 11, 0, 12),
			sqlTok('FROM', 13, 16, 0, 17),
			sqlTok('VAR', 18, 18, 0, 19),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('Wildcard');
	});

	it('no violation for STAR before named columns', () => {
		// SELECT *, id FROM t
		const sql = 'SELECT *, id FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('COMMA', 8, 8, 0, 9),
			sqlTok('VAR', 10, 11, 0, 12),
			sqlTok('FROM', 13, 16, 0, 17),
			sqlTok('VAR', 18, 18, 0, 19),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for SELECT * only', () => {
		// SELECT * FROM t
		const sql = 'SELECT * FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for SELECT id, name (no wildcard)', () => {
		// SELECT id, name FROM t
		const sql = 'SELECT id, name FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),
			sqlTok('COMMA', 9, 9, 0, 10),
			sqlTok('VAR', 11, 14, 0, 15),
			sqlTok('FROM', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('treats qualified wildcard (table.*) as non-star for ordering', () => {
		// SELECT id, t.* FROM t
		// t.* appears after id but t.* is qualified — treated as named column
		const sql = 'SELECT id, t.* FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),
			sqlTok('COMMA', 9, 9, 0, 10),
			sqlTok('VAR', 11, 11, 0, 12),
			sqlTok('DOT', 12, 12, 0, 13),
			sqlTok('STAR', 13, 13, 0, 14),
			sqlTok('FROM', 15, 18, 0, 19),
			sqlTok('VAR', 20, 20, 0, 21),
		];
		// t.* is qualified, so no violation even though it appears after id
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag STAR inside subquery', () => {
		// SELECT id, (SELECT * FROM sub) AS sub_val FROM t
		// The STAR inside the subquery is at depth > 0 and should not be flagged.
		const sql = 'SELECT id, (SELECT * FROM sub) AS sub_val FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),
			sqlTok('COMMA', 9, 9, 0, 10),
			sqlTok('L_PAREN', 11, 11, 0, 12),
			sqlTok('SELECT', 12, 17, 0, 18),
			sqlTok('STAR', 19, 19, 0, 20),        // inside subquery — should not trigger
			sqlTok('FROM', 21, 24, 0, 25),
			sqlTok('VAR', 26, 28, 0, 29),
			sqlTok('R_PAREN', 29, 29, 0, 30),
			sqlTok('VAR', 31, 32, 0, 33),
			sqlTok('VAR', 34, 40, 0, 41),
			sqlTok('FROM', 42, 45, 0, 46),
			sqlTok('VAR', 47, 47, 0, 48),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('SELECT 1');
		const m = model({});
		expect(columnOrderRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
