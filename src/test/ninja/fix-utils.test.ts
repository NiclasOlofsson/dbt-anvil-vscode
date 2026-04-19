import { describe, it, expect } from 'vitest';
import { lastContentTokenOnLine, firstContentTokenOnLine, tokenStartCol } from '../../ninja/fix-utils';
import { sqlTok } from './helpers';

describe('lastContentTokenOnLine', () => {
	it('returns undefined for an empty token list', () => {
		expect(lastContentTokenOnLine([], 0)).toBeUndefined();
	});

	it('returns undefined when no token is on the requested line', () => {
		const tokens = [sqlTok('SELECT', 0, 5, 0, 6), sqlTok('VAR', 7, 7, 0, 8)];
		expect(lastContentTokenOnLine(tokens, 1)).toBeUndefined();
	});

	it('returns the only token on a single-token line', () => {
		const tokens = [sqlTok('SELECT', 0, 5, 0, 6)];
		expect(lastContentTokenOnLine(tokens, 0)).toBe(tokens[0]);
	});

	it('returns the rightmost token when multiple tokens share a line', () => {
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
		];
		expect(lastContentTokenOnLine(tokens, 0)).toBe(tokens[2]);
	});

	it('isolates tokens to the requested line', () => {
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 9, 9, 1, 2),
			sqlTok('FROM', 11, 14, 2, 5),
		];
		expect(lastContentTokenOnLine(tokens, 1)).toBe(tokens[1]);
	});
});

describe('firstContentTokenOnLine', () => {
	it('returns undefined for an empty token list', () => {
		expect(firstContentTokenOnLine([], 0)).toBeUndefined();
	});

	it('returns undefined when no token is on the requested line', () => {
		const tokens = [sqlTok('SELECT', 0, 5, 0, 6)];
		expect(firstContentTokenOnLine(tokens, 1)).toBeUndefined();
	});

	it('returns the leftmost token when multiple tokens share a line', () => {
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
		];
		expect(firstContentTokenOnLine(tokens, 0)).toBe(tokens[0]);
	});

	it('skips earlier lines and stops at the matched line', () => {
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 9, 9, 1, 2),
			sqlTok('FROM', 11, 14, 1, 7),
		];
		expect(firstContentTokenOnLine(tokens, 1)).toBe(tokens[1]);
	});
});

describe('tokenStartCol', () => {
	it('returns 0 for a token at the very start of a line', () => {
		// 'SELECT' at offsets 0..5 inclusive on line 0; sqlglot col = 6 (1-based end)
		expect(tokenStartCol(sqlTok('SELECT', 0, 5, 0, 6))).toBe(0);
	});

	it('returns the start column for a mid-line token', () => {
		// 'FROM' at offsets 9..12 inclusive on line 0, end col = 13 → start col = 9
		expect(tokenStartCol(sqlTok('FROM', 9, 12, 0, 13))).toBe(9);
	});

	it('returns the start column for a single-character token', () => {
		// 'COMMA' at offset 25 on line 1 → end col = 1 → start col = 0
		expect(tokenStartCol(sqlTok('COMMA', 25, 25, 1, 1))).toBe(0);
	});
});
