import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { trailingCommaRule } from '../../ninja/rules/convention-trailing-comma';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/sql-tokens';
import { DEFAULT_CONFIG } from '../../ninja/config';

const RULE = 'ninja.convention.trailing-comma';

function trailingCfg(commaPosition: 'trailing' | 'leading') {
	return cfg({ layout: { commaPosition, operatorPosition: DEFAULT_CONFIG.layout.operatorPosition } });
}

/**
 * Build a minimal token set from a multi-line SQL string.
 * Only SELECT, COMMA, FROM (and similar clause keywords) tokens are needed.
 */
function check(sql: string, tokens: SqlToken[], commaPosition: 'trailing' | 'leading') {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return trailingCommaRule.check({ model: m, document: doc, config: trailingCfg(commaPosition) });
}

// ── helpers to build offset-correct tokens from a string ──────────────────

function offsets(sql: string, sub: string): { start: number; end: number; line: number } {
	const idx = sql.indexOf(sub);
	if (idx === -1) throw new Error(`'${sub}' not found in sql`);
	const before = sql.slice(0, idx);
	const line = (before.match(/\n/g) ?? []).length;
	return { start: idx, end: idx + sub.length - 1, line };
}

// ── Trailing-comma policy ──────────────────────────────────────────────────

describe(RULE, () => {
	it('no violation when last column has trailing comma (trailing mode)', () => {
		// select
		//   a,
		//   b,
		// from t
		const sql = 'select\n  a,\n  b,\nfrom t';
		const toks: SqlToken[] = [
			{ ...offsets(sql, 'select'), type: 'SELECT', col: 6 },
			{ ...offsets(sql, 'a'), type: 'VAR', col: 2 },
			{ start: sql.indexOf('a') + 1, end: sql.indexOf('a') + 1, line: 1, type: 'COMMA', col: 3 },
			{ ...offsets(sql, 'b'), type: 'VAR', col: 2 },
			{ start: sql.indexOf('b') + 1, end: sql.indexOf('b') + 1, line: 2, type: 'COMMA', col: 3 },
			{ ...offsets(sql, 'from'), type: 'FROM', col: 4 },
		];
		expect(check(sql, toks, 'trailing')).toHaveLength(0);
	});

	it('does not flag a missing trailing comma in trailing mode (rule is leading-only)', () => {
		// Neither sqlfmt nor the current dbt-labs guide require a trailing
		// comma after the last target. The rule no longer enforces it.
		const sql = 'select\n  a,\n  b\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 9, 9, 1, 2),
			sqlTok('COMMA', 10, 10, 1, 3),
			sqlTok('VAR', 14, 14, 2, 2),
			sqlTok('FROM', 16, 19, 3, 4),
		];
		expect(check(sql, toks, 'trailing')).toHaveLength(0);
	});

	// ── Leading-comma policy ───────────────────────────────────────────────

	it('no violation when no trailing comma on last item (leading mode)', () => {
		// select
		//   a
		//   ,b
		// from t
		const sql = 'select\n  a\n  ,b\nfrom t';
		// 'select'=0-5 l0, 'a'=9 l1, ','=13 l2, 'b'=14 l2, 'from'=16 l3
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 9, 9, 1, 2),
			sqlTok('COMMA', 13, 13, 2, 3),
			sqlTok('VAR', 14, 14, 2, 4),
			sqlTok('FROM', 16, 19, 3, 4),
		];
		expect(check(sql, toks, 'leading')).toHaveLength(0);
	});

	it('flags trailing comma on last item in leading mode', () => {
		// select
		//   a
		//   ,b,
		// from t   <- trailing comma after b is wrong in leading mode
		const sql = 'select\n  a\n  ,b,\nfrom t';
		// offsets: select=0 l0, a=9 l1, ,=13 l2, b=14 l2, ,=15 l2, from=17 l3
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 9, 9, 1, 2),
			sqlTok('COMMA', 13, 13, 2, 3),
			sqlTok('VAR', 14, 14, 2, 4),
			sqlTok('COMMA', 15, 15, 2, 5),
			sqlTok('FROM', 17, 20, 3, 4),
		];
		const v = check(sql, toks, 'leading');
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('not allowed');
		expect((v[0].action as FixAction).ops[0].kind).toBe('delete');
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('skips single-line SELECT (same line as SELECT keyword)', () => {
		const sql = 'select a, b from t';
		// All tokens on line 0 → single-line → skip
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('COMMA', 8, 8, 0, 9),
			sqlTok('VAR', 10, 10, 0, 11),
			sqlTok('FROM', 12, 15, 0, 16),
		];
		expect(check(sql, toks, 'trailing')).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select\n  a,\n  b\nfrom t');
		const m = model({});
		expect(trailingCommaRule.check({ model: m, document: doc, config: trailingCfg('trailing') })).toHaveLength(0);
	});

	it('no violations for single-column SELECT', () => {
		// select
		//   a
		// from t   <- only one column, no comma at all
		const sql = 'select\n  a\nfrom t';
		const toks: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 9, 9, 1, 2),
			sqlTok('FROM', 11, 14, 2, 4),
		];
		expect(check(sql, toks, 'trailing')).toHaveLength(0);
	});
});
