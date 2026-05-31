import { describe, it, expect } from 'vitest';
import {
	matchesStyle,
	convertToStyle,
	segmentIdentifier,
	type IdentifierStyle,
} from '../../ninja/identifier-style';

describe('identifier-style', () => {
	// ── matchesStyle ──────────────────────────────────────────────────────

	describe('matchesStyle', () => {
		const cases: Array<[string, IdentifierStyle, boolean]> = [
			// snake_case: lowercase letters, digits, underscores; starts with letter
			['order_id', 'snake_case', true],
			['customer_id_pk', 'snake_case', true],
			['order', 'snake_case', true],            // single lowercase word counts
			['order1', 'snake_case', true],
			['_order', 'snake_case', false],          // leading underscore — reject
			['orderId', 'snake_case', false],         // has uppercase
			['Order_id', 'snake_case', false],        // has uppercase
			['ORDER_ID', 'snake_case', false],
			['', 'snake_case', false],

			// camelCase: starts lowercase, contains uppercase, no underscores/dashes
			['orderId', 'camelCase', true],
			['orderIdPk', 'camelCase', true],
			['order', 'camelCase', true],             // single lowercase word counts
			['OrderId', 'camelCase', false],          // starts uppercase
			['order_id', 'camelCase', false],         // has underscore
			['order-id', 'camelCase', false],         // has dash
			['orderID', 'camelCase', false],          // consecutive uppercase without acronym
			['', 'camelCase', false],

			// PascalCase: starts uppercase, no underscores/dashes
			['OrderId', 'PascalCase', true],
			['Order', 'PascalCase', true],
			['orderId', 'PascalCase', false],         // starts lowercase
			['Order_id', 'PascalCase', false],        // has underscore
			['ORDER', 'PascalCase', false],           // all uppercase — not Pascal (it's upper)
			['OrderID', 'PascalCase', false],         // consecutive uppercase without acronym

			// lower: all lowercase letters/digits, no separators
			['order', 'lower', true],
			['orderid', 'lower', true],
			['order123', 'lower', true],
			['order_id', 'lower', false],
			['orderId', 'lower', false],

			// upper: all uppercase letters/digits, no separators
			['ORDER', 'upper', true],
			['ORDERID', 'upper', true],
			['ORDER123', 'upper', true],
			['ORDER_ID', 'upper', false],             // underscore disqualifies
			['Order', 'upper', false],
		];

		for (const [name, style, expected] of cases) {
			it(`matchesStyle(${JSON.stringify(name)}, ${style}) === ${expected}`, () => {
				expect(matchesStyle(name, style)).toBe(expected);
			});
		}

		// Acronym handling: consecutive uppercase runs that match a known acronym
		// are allowed in camelCase / PascalCase.
		it('treats known acronyms as a single token in camelCase', () => {
			const acronyms = new Set(['URL', 'ID']);
			expect(matchesStyle('myURL', 'camelCase', { acronyms })).toBe(true);
			expect(matchesStyle('orderID', 'camelCase', { acronyms })).toBe(true);
			// Acronym at start of camelCase is not allowed (must start lowercase).
			expect(matchesStyle('URLPath', 'camelCase', { acronyms })).toBe(false);
		});

		it('treats known acronyms as a single token in PascalCase', () => {
			const acronyms = new Set(['URL', 'ID']);
			expect(matchesStyle('MyURL', 'PascalCase', { acronyms })).toBe(true);
			expect(matchesStyle('URLPath', 'PascalCase', { acronyms })).toBe(true);
			expect(matchesStyle('OrderID', 'PascalCase', { acronyms })).toBe(true);
		});

		it('rejects unknown acronyms in camelCase / PascalCase', () => {
			// Default acronyms empty.
			expect(matchesStyle('myURL', 'camelCase')).toBe(false);
			expect(matchesStyle('MyURL', 'PascalCase')).toBe(false);
		});
	});

	// ── convertToStyle ────────────────────────────────────────────────────

	describe('convertToStyle', () => {
		// Conversions with visible markers — produce a deterministic result.
		// The function always renders; the caller compares against the input
		// to detect whether the conversion changed anything.
		const cases: Array<[string, IdentifierStyle, string]> = [
			// to snake_case
			['orderId', 'snake_case', 'order_id'],
			['OrderId', 'snake_case', 'order_id'],
			['OrderID_pk', 'snake_case', 'order_id_pk'],    // multi-upper run kept as one
			['order_id', 'snake_case', 'order_id'],          // already conforms
			['ORDER_ID', 'snake_case', 'order_id'],
			['Order', 'snake_case', 'order'],
			['orderid', 'snake_case', 'orderid'],            // single-word stays single-word
			['order', 'snake_case', 'order'],

			// to camelCase
			['order_id', 'camelCase', 'orderId'],
			['ORDER_ID', 'camelCase', 'orderId'],
			['OrderId', 'camelCase', 'orderId'],
			['orderId', 'camelCase', 'orderId'],             // already conforms
			['order', 'camelCase', 'order'],

			// to PascalCase
			['order_id', 'PascalCase', 'OrderId'],
			['orderId', 'PascalCase', 'OrderId'],
			['OrderId', 'PascalCase', 'OrderId'],            // already conforms
			['ORDER_ID', 'PascalCase', 'OrderId'],
			['order', 'PascalCase', 'Order'],

			// to lower / upper (no separators by definition)
			['Order_Id', 'lower', 'orderid'],
			['Order', 'lower', 'order'],
			['Order', 'upper', 'ORDER'],
			['order_id', 'lower', 'orderid'],
			['order_id', 'upper', 'ORDERID'],
		];

		for (const [name, target, expected] of cases) {
			it(`convertToStyle(${JSON.stringify(name)}, ${target}) === ${JSON.stringify(expected)}`, () => {
				expect(convertToStyle(name, target)).toBe(expected);
			});
		}

		it('uses acronym list to preserve runs in camelCase target', () => {
			const acronyms = new Set(['URL', 'ID']);
			expect(convertToStyle('my_url', 'camelCase', { acronyms })).toBe('myURL');
			expect(convertToStyle('order_id', 'camelCase', { acronyms })).toBe('orderID');
		});

		it('uses acronym list to preserve runs in PascalCase target', () => {
			const acronyms = new Set(['URL']);
			expect(convertToStyle('my_url_path', 'PascalCase', { acronyms })).toBe('MyURLPath');
		});

		it('uses acronym list when converting from camelCase containing acronym to snake_case', () => {
			const acronyms = new Set(['URL', 'ID']);
			expect(convertToStyle('myURL', 'snake_case', { acronyms })).toBe('my_url');
			expect(convertToStyle('orderID', 'snake_case', { acronyms })).toBe('order_id');
			expect(convertToStyle('MyURLPath', 'snake_case', { acronyms })).toBe('my_url_path');
		});

		it('returns null only on empty input', () => {
			expect(convertToStyle('', 'snake_case')).toBe(null);
		});

		it('uses word list to segment all-lowercase identifiers', () => {
			const words = new Set(['id', 'key']);
			expect(convertToStyle('customerid', 'snake_case', { words })).toBe('customer_id');
			expect(convertToStyle('mykey', 'snake_case', { words })).toBe('my_key');
			// No matching suffix — returns input as-is (no fabricated boundary).
			expect(convertToStyle('myunknown', 'snake_case', { words })).toBe('myunknown');
		});
	});

	// ── segmentIdentifier ─────────────────────────────────────────────────

	describe('segmentIdentifier', () => {
		it('segments on visible case transitions', () => {
			expect(segmentIdentifier('orderId')).toEqual(['order', 'Id']);
			expect(segmentIdentifier('OrderIdPk')).toEqual(['Order', 'Id', 'Pk']);
		});

		it('segments on underscores', () => {
			expect(segmentIdentifier('order_id')).toEqual(['order', 'id']);
			expect(segmentIdentifier('ORDER_ID')).toEqual(['ORDER', 'ID']);
		});

		it('segments on dashes', () => {
			expect(segmentIdentifier('order-id')).toEqual(['order', 'id']);
		});

		it('keeps known acronyms as a single segment', () => {
			const acronyms = new Set(['URL', 'ID']);
			expect(segmentIdentifier('myURL', { acronyms })).toEqual(['my', 'URL']);
			expect(segmentIdentifier('orderID', { acronyms })).toEqual(['order', 'ID']);
			expect(segmentIdentifier('MyURLPath', { acronyms })).toEqual(['My', 'URL', 'Path']);
		});

		it('uses word list to segment all-lowercase identifiers', () => {
			const words = new Set(['id', 'key']);
			expect(segmentIdentifier('customerid', { words })).toEqual(['customer', 'id']);
			expect(segmentIdentifier('mykey', { words })).toEqual(['my', 'key']);
		});

		it('returns single segment when no markers and no matching word', () => {
			expect(segmentIdentifier('customerid')).toEqual(['customerid']);
			expect(segmentIdentifier('order')).toEqual(['order']);
		});

		it('handles empty string', () => {
			expect(segmentIdentifier('')).toEqual([]);
		});
	});
});
