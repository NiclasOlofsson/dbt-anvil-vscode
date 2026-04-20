import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { capIdentifiersRule } from '../../ninja/rules/cap-identifiers';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.cap.identifiers';

/**
 * Build a minimal SqlToken for an identifier (VAR type) at the given position.
 */
function varTok(word: string, line: number, absStart: number): SqlToken {
	return sqlTok('VAR', absStart, absStart + word.length - 1, line, absStart + word.length);
}

/**
 * Run the rule against a set of explicit tokens.
 * The sql text just needs to contain the words at the expected offsets.
 */
function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return capIdentifiersRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	// ── No violations ─────────────────────────────────────────────────────

	it('passes all-lowercase identifiers', () => {
		const sql = 'select order_id, customer_id from orders';
		const tokens: SqlToken[] = [
			varTok('order_id', 0, 7),
			varTok('customer_id', 0, 17),
			varTok('orders', 0, 34),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('passes all-uppercase identifiers', () => {
		const sql = 'select ORDER_ID, CUSTOMER_ID from ORDERS';
		const tokens: SqlToken[] = [
			varTok('ORDER_ID', 0, 7),
			varTok('CUSTOMER_ID', 0, 17),
			varTok('ORDERS', 0, 34),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('passes single-character identifiers regardless of case', () => {
		// Single-char identifiers (e.g. aliases) are always skipped.
		const sql = 'select a, b, c from t';
		const tokens: SqlToken[] = [
			varTok('a', 0, 7),
			varTok('b', 0, 10),
			varTok('c', 0, 13),
			varTok('t', 0, 20),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('passes empty token stream', () => {
		const v = check('', []);
		expect(v).toHaveLength(0);
	});

	// ── Mixed-case detection ───────────────────────────────────────────────

	it('flags mixed-case identifier', () => {
		const sql = 'select OrderId from t';
		const tokens: SqlToken[] = [varTok('OrderId', 0, 7)];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('OrderId');
		expect(v[0].message).toContain('mixed-case');
	});

	it('flags multiple mixed-case identifiers', () => {
		const sql = 'select OrderId, CustomerId from t';
		const tokens: SqlToken[] = [
			varTok('OrderId', 0, 7),
			varTok('CustomerId', 0, 16),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
	});

	// ── Consistency policy ─────────────────────────────────────────────────

	it('flags uppercase identifier when first was lowercase', () => {
		// First: order_id (lower) → second: CUSTOMER_ID (upper) → violation
		const sql = 'select order_id, CUSTOMER_ID from t';
		const tokens: SqlToken[] = [
			varTok('order_id', 0, 7),
			varTok('CUSTOMER_ID', 0, 17),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('CUSTOMER_ID');
	});

	it('flags lowercase identifier when first was uppercase', () => {
		// First: ORDER_ID (upper) → second: customer_id (lower) → violation
		const sql = 'select ORDER_ID, customer_id from t';
		const tokens: SqlToken[] = [
			varTok('ORDER_ID', 0, 7),
			varTok('customer_id', 0, 17),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('customer_id');
	});

	it('does not flag second identifier when same case as first', () => {
		const sql = 'select order_id, customer_id from t';
		const tokens: SqlToken[] = [
			varTok('order_id', 0, 7),
			varTok('customer_id', 0, 17),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	// ── Quoted identifiers are skipped ────────────────────────────────────

	it('skips QUOTED_IDENTIFIER tokens', () => {
		const sql = 'select "OrderId" from t';
		// Quoted identifier — must not be checked.
		const tokens: SqlToken[] = [sqlTok('QUOTED_IDENTIFIER', 7, 15, 0, 16)];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	it('skips BACKTICK tokens', () => {
		const sql = 'select `OrderId` from t';
		const tokens: SqlToken[] = [sqlTok('BACKTICK', 7, 15, 0, 16)];
		const v = check(sql, tokens);
		expect(v).toHaveLength(0);
	});

	// ── Range is correct ──────────────────────────────────────────────────

	it('violation range covers the identifier', () => {
		const sql = 'select OrderId from t';
		const tokens: SqlToken[] = [varTok('OrderId', 0, 7)];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(7);
		expect(v[0].range.end.character).toBe(14); // 7 + length('OrderId') = 14
	});

	it('violation range is correct on a non-zero line', () => {
		const sql = 'select\n    OrderId\nfrom t';
		//             line 1, col 4 is 'O'
		// Absolute offset of 'OrderId' on line 1 col 4 = 7 (select\n) + 4 = 11
		const tokens: SqlToken[] = [varTok('OrderId', 1, 11)];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].range.start.line).toBe(1);
		expect(v[0].range.start.character).toBe(4);
	});
});
