import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { aliasLengthRule } from '../../ninja/rules/alias-length';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.alias.length';

/**
 * Build a VAR token for an alias word.
 */
function varTok(word: string, line: number, absStart: number): SqlToken {
	return sqlTok('VAR', absStart, absStart + word.length - 1, line, absStart + word.length);
}

/**
 * Build an AS keyword token at the given position.
 * sqlglot emits the AS keyword as type 'AS'.
 */
function asTok(line: number, absStart: number): SqlToken {
	return sqlTok('AS', absStart, absStart + 1, line, absStart + 2);
}

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return aliasLengthRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── No violations ─────────────────────────────────────────────────────

	it('passes alias with 2 characters', () => {
		// 'select 1 from orders AS od'
		//  0123456789012345678901234 5
		//                        ^21 = A, 22 = S, 23 = space, 24 = o, 25 = d
		const sql = 'select 1 from orders AS od';
		const tokens: SqlToken[] = [
			asTok(0, 21),   // AS at offset 21
			varTok('od', 0, 24), // od at offset 24
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('passes alias with 3 characters', () => {
		// 'select 1 from orders AS ord'
		const sql = 'select 1 from orders AS ord';
		const tokens: SqlToken[] = [
			asTok(0, 21),
			varTok('ord', 0, 24),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('passes a long descriptive alias', () => {
		// 'select 1 from orders AS order_base'
		const sql = 'select 1 from orders AS order_base';
		const tokens: SqlToken[] = [
			asTok(0, 21),
			varTok('order_base', 0, 24),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('no violations when no AS token present', () => {
		const sql = 'select order_id from orders';
		// 'orders' starts at offset 21
		const tokens: SqlToken[] = [varTok('orders', 0, 21)];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('passes empty token stream', () => {
		const v = check('', []);
		expect(v).toHaveLength(0);
	});

	// ── Single-character alias detection ──────────────────────────────────

	it('flags 1-character alias after AS', () => {
		// 'select 1 from orders AS o'
		//  0123456789012345678901234
		//                        ^21=A, 22=S, 23=space, 24=o
		const sql = 'select 1 from orders AS o';
		const tokens: SqlToken[] = [
			asTok(0, 21),
			varTok('o', 0, 24),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('\'o\'');
	});

	it('flags multiple 1-character aliases', () => {
		// 'select 1 from orders AS o join customers AS c on o.id = c.id'
		//  0         1         2         3         4
		//  0123456789012345678901234567890123456789012345
		//  AS at 21, o at 24, AS at 41, c at 44
		const sql = 'select 1 from orders AS o join customers AS c on o.id = c.id';
		const tokens: SqlToken[] = [
			asTok(0, 21),
			varTok('o', 0, 24),
			asTok(0, 41),
			varTok('c', 0, 44),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
	});

	// ── AS followed by non-VAR token ──────────────────────────────────────

	it('does not flag AS when followed by a non-identifier token', () => {
		// e.g. CAST(x AS INT) — AS followed by type keyword, not a VAR
		const sql = 'select cast(x as int) from t';
		const tokens: SqlToken[] = [
			asTok(0, 14),
			sqlTok('INT', 17, 19, 0, 20), // keyword, not VAR
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	// ── Range is correct ──────────────────────────────────────────────────

	it('violation range covers the alias identifier', () => {
		// 'select 1 from orders AS o'
		// 'o' (alias) is at absolute offset 24, col 24 on line 0.
		const sql = 'select 1 from orders AS o';
		const tokens: SqlToken[] = [
			asTok(0, 21),
			varTok('o', 0, 24),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(24);
		expect(v[0].range.end.character).toBe(25);
	});

	it('violation range is correct on a non-zero line', () => {
		// 'select 1\nfrom orders AS o'
		// Line 0: 'select 1' (8 chars + newline = offset 9 for line 1)
		// Line 1: 'from orders AS o'
		//          0123456789012345
		//          AS at col 12 (offset 9+12=21), o at col 15 (offset 9+15=24)
		const sql = 'select 1\nfrom orders AS o';
		const tokens: SqlToken[] = [
			asTok(1, 21),
			varTok('o', 1, 24),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(1);
	});
});
