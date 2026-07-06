import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { selectModifiersRule } from '../../ninja/rules/layout-select-modifiers';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.layout.select-modifiers';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return selectModifiersRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── Should flag ────────────────────────────────────────────────────────────

	it('flags DISTINCT on the line after SELECT', () => {
		const sql = 'SELECT\n    DISTINCT\n    a\nFROM t';
		// line 0: SELECT
		// line 1:     DISTINCT
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 11, 18, 1, 12),
			sqlTok('VAR', 24, 24, 2, 6),
			sqlTok('FROM', 26, 29, 3, 4),
			sqlTok('VAR', 31, 31, 3, 6),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('DISTINCT');
		expect(v[0].range.start.line).toBe(1);
	});

	it('flags TOP on the line after SELECT', () => {
		const sql = 'SELECT\n    TOP 10\n    a\nFROM t';
		// line 0: SELECT
		// line 1:     TOP 10
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('TOP', 11, 13, 1, 8),
			sqlTok('NUMBER', 15, 16, 1, 11),
			sqlTok('VAR', 22, 22, 2, 6),
			sqlTok('FROM', 24, 27, 3, 4),
			sqlTok('VAR', 29, 29, 3, 6),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('TOP');
		expect(v[0].range.start.line).toBe(1);
	});

	it('flags DISTINCT multiple lines after SELECT', () => {
		// SELECT on line 0, DISTINCT on line 2
		const sql = 'SELECT\n\n    DISTINCT a\nFROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 12, 19, 2, 12),
			sqlTok('VAR', 21, 21, 2, 14),
			sqlTok('FROM', 23, 26, 3, 4),
			sqlTok('VAR', 28, 28, 3, 6),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(2);
	});

	// ── Should NOT flag ────────────────────────────────────────────────────────

	it('does not flag DISTINCT on the same line as SELECT', () => {
		const sql = 'SELECT DISTINCT a FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
			sqlTok('VAR', 16, 16, 0, 17),
			sqlTok('FROM', 18, 21, 0, 22),
			sqlTok('VAR', 23, 23, 0, 24),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag TOP on the same line as SELECT', () => {
		const sql = 'SELECT TOP 10 a FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('TOP', 7, 9, 0, 10),
			sqlTok('NUMBER', 11, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('FROM', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag a regular column token after SELECT on the next line', () => {
		// SELECT followed immediately by a column name (no modifier)
		const sql = 'SELECT\n    a\nFROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 11, 11, 1, 6),
			sqlTok('FROM', 13, 16, 2, 4),
			sqlTok('VAR', 18, 18, 2, 6),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag when SELECT is at end of token stream', () => {
		// Degenerate: SELECT with no following tokens
		const sql = 'SELECT';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('returns no violations when ninjaSqlTokens is absent', () => {
		const doc = mockDocument('SELECT\nDISTINCT a');
		const m = model({});
		expect(selectModifiersRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	// ── Multiple SELECT statements ─────────────────────────────────────────────

	it('flags only the SELECT whose modifier is on a different line', () => {
		// First SELECT: DISTINCT on same line — ok
		// Second SELECT: DISTINCT on next line — flagged
		const sql = 'SELECT DISTINCT a FROM t\nUNION ALL\nSELECT\n    DISTINCT b\nFROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
			sqlTok('VAR', 16, 16, 0, 17),
			sqlTok('FROM', 18, 21, 0, 22),
			sqlTok('VAR', 23, 23, 0, 24),
			sqlTok('UNION', 25, 29, 1, 5),
			sqlTok('ALL', 31, 33, 1, 9),
			sqlTok('SELECT', 35, 40, 2, 6),
			sqlTok('DISTINCT', 46, 53, 3, 12),
			sqlTok('VAR', 55, 55, 3, 14),
			sqlTok('FROM', 57, 60, 4, 4),
			sqlTok('VAR', 62, 62, 4, 6),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(3);
	});

	it('flags both SELECT statements when both have modifiers on next line', () => {
		const sql = 'SELECT\n    DISTINCT a\nFROM t\nUNION ALL\nSELECT\n    TOP 5\n    b\nFROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 11, 18, 1, 12),
			sqlTok('VAR', 20, 20, 1, 14),
			sqlTok('FROM', 22, 25, 2, 4),
			sqlTok('VAR', 27, 27, 2, 6),
			sqlTok('UNION', 29, 33, 3, 5),
			sqlTok('ALL', 35, 37, 3, 9),
			sqlTok('SELECT', 39, 44, 4, 6),
			sqlTok('TOP', 50, 52, 5, 7),
			sqlTok('NUMBER', 54, 54, 5, 9),
			sqlTok('VAR', 60, 60, 6, 6),
			sqlTok('FROM', 62, 65, 7, 4),
			sqlTok('VAR', 67, 67, 7, 6),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
	});
});
