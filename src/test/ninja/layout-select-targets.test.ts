import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { selectTargetsRule } from '../../ninja/rules/layout-select-targets';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.layout.select-targets';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return selectTargetsRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── Should flag ────────────────────────────────────────────────────────────

	it('flags two columns on the same line as SELECT', () => {
		// SELECT a, b FROM t
		// 0123456789012345678
		const sql = 'SELECT a, b FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('COMMA', 8, 8, 0, 9),
			sqlTok('VAR', 10, 10, 0, 11),
			sqlTok('FROM', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].range.start.line).toBe(0);
	});

	it('flags three columns on the same line as SELECT', () => {
		const sql = 'SELECT a, b, c FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('COMMA', 8, 8, 0, 9),
			sqlTok('VAR', 10, 10, 0, 11),
			sqlTok('COMMA', 11, 11, 0, 12),
			sqlTok('VAR', 13, 13, 0, 14),
			sqlTok('FROM', 15, 18, 0, 19),
			sqlTok('VAR', 20, 20, 0, 21),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('flags SELECT without FROM when all targets on same line', () => {
		// e.g. subquery: SELECT a, b
		const sql = 'SELECT a, b';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('COMMA', 8, 8, 0, 9),
			sqlTok('VAR', 10, 10, 0, 11),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('flags when targets follow SELECT on line 2', () => {
		// A SELECT that begins on line 1, targets on the same line 1
		const sql = 'WITH cte AS (\n    SELECT a, b\n    FROM t\n)';
		// Line 1 (0-based): '    SELECT a, b'
		// SELECT starts at offset 14
		const tokens: SqlToken[] = [
			sqlTok('WITH', 0, 3, 0, 4),
			sqlTok('VAR', 5, 7, 0, 8),
			sqlTok('AS', 9, 10, 0, 11),
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('SELECT', 18, 23, 1, 10),
			sqlTok('VAR', 25, 25, 1, 12),
			sqlTok('COMMA', 26, 26, 1, 13),
			sqlTok('VAR', 28, 28, 1, 15),
			sqlTok('FROM', 34, 37, 2, 8),
			sqlTok('VAR', 39, 39, 2, 10),
			sqlTok('R_PAREN', 41, 41, 3, 1),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(1);
	});

	// ── Should NOT flag ────────────────────────────────────────────────────────

	it('does not flag SELECT with a single column', () => {
		const sql = 'SELECT a FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag SELECT *', () => {
		const sql = 'SELECT * FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('STAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag SELECT 1', () => {
		const sql = 'SELECT 1';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag when columns are already on separate lines', () => {
		const sql = 'SELECT\n    a,\n    b\nFROM t';
		// line 0: SELECT (line 0)
		// line 1: a, (line 1)
		// line 2: b  (line 2)
		// line 3: FROM t
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 11, 11, 1, 6),
			sqlTok('COMMA', 12, 12, 1, 7),
			sqlTok('VAR', 18, 18, 2, 6),
			sqlTok('FROM', 20, 23, 3, 4),
			sqlTok('VAR', 25, 25, 3, 6),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag when comma is inside a function call (depth > 0)', () => {
		// SELECT COALESCE(a, b) FROM t — the comma is inside parens, depth 1
		const sql = 'SELECT COALESCE(a, b) FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 14, 0, 15),       // COALESCE
			sqlTok('L_PAREN', 15, 15, 0, 16),
			sqlTok('VAR', 16, 16, 0, 17),       // a
			sqlTok('COMMA', 17, 17, 0, 18),     // inside parens — depth 1
			sqlTok('VAR', 19, 19, 0, 20),       // b
			sqlTok('R_PAREN', 20, 20, 0, 21),
			sqlTok('FROM', 22, 25, 0, 26),
			sqlTok('VAR', 27, 27, 0, 28),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag nested subquery SELECT with targets on one line inside parens', () => {
		// Outer SELECT is already expanded; inner is in parens so its tokens
		// contribute to depth > 0 from the outer SELECT's perspective.
		// Outer: SELECT\n    sub\nFROM (SELECT x, y FROM t)
		const sql = 'SELECT\n    sub\nFROM (\n    SELECT x, y\n    FROM t\n)';
		// Outer SELECT on line 0, depth 0 — no commas at depth 0 before FROM
		// Inner SELECT on line 3, depth 0 from its own iteration — but it IS
		// inside the outer's paren scope. However the rule iterates every SELECT,
		// so the inner SELECT will also be visited and flagged if targets are
		// on the same line as that SELECT.
		// This test just verifies the outer SELECT is not flagged (no top-level comma).
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 11, 13, 1, 8),          // sub
			sqlTok('FROM', 15, 18, 2, 4),
			sqlTok('L_PAREN', 20, 20, 2, 6),
			sqlTok('SELECT', 26, 31, 3, 10),       // inner SELECT
			sqlTok('VAR', 33, 33, 3, 12),          // x
			sqlTok('COMMA', 34, 34, 3, 13),        // inner comma
			sqlTok('VAR', 36, 36, 3, 15),          // y
			sqlTok('FROM', 42, 45, 4, 8),
			sqlTok('VAR', 47, 47, 4, 10),
			sqlTok('R_PAREN', 49, 49, 5, 1),
		];
		const v = check(sql, tokens);
		// Only the inner SELECT (line 3) should be flagged; outer should not.
		expect(v.every(x => x.range.start.line !== 0)).toBe(true);
	});

	it('returns no violations when ninjaSqlTokens is absent', () => {
		const doc = mockDocument('SELECT a, b');
		const m = model({});
		expect(selectTargetsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	// ── Paren depth tracking ───────────────────────────────────────────────────

	it('counts commas at depth 0 only — mixed inner and outer commas', () => {
		// SELECT FUNC(a, b), c  — one top-level comma (between FUNC(...) and c),
		// one inner comma (a, b inside parens).  Should flag.
		const sql = 'SELECT FUNC(a, b), c FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 10, 0, 11),        // FUNC
			sqlTok('L_PAREN', 11, 11, 0, 12),
			sqlTok('VAR', 12, 12, 0, 13),        // a
			sqlTok('COMMA', 13, 13, 0, 14),      // depth-1 comma
			sqlTok('VAR', 15, 15, 0, 16),        // b
			sqlTok('R_PAREN', 16, 16, 0, 17),
			sqlTok('COMMA', 17, 17, 0, 18),      // depth-0 comma
			sqlTok('VAR', 19, 19, 0, 20),        // c
			sqlTok('FROM', 21, 24, 0, 25),
			sqlTok('VAR', 26, 26, 0, 27),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('does not flag when only inner parens contain commas', () => {
		// SELECT FUNC(a, b) FROM t — no top-level comma
		const sql = 'SELECT FUNC(a, b) FROM t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 10, 0, 11),
			sqlTok('L_PAREN', 11, 11, 0, 12),
			sqlTok('VAR', 12, 12, 0, 13),
			sqlTok('COMMA', 13, 13, 0, 14),      // depth-1 comma
			sqlTok('VAR', 15, 15, 0, 16),
			sqlTok('R_PAREN', 16, 16, 0, 17),
			sqlTok('FROM', 18, 21, 0, 22),
			sqlTok('VAR', 23, 23, 0, 24),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});
});
