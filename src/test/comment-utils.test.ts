import { describe, it, expect } from 'vitest';
import {
	computeCommentRanges,
	isOffsetInComment,
	isLinePositionInComment,
} from '../providers/comment-utils';

describe('computeCommentRanges', () => {
	it('detects line comments (--)', () => {
		const text = 'SELECT 1 -- hello\nFROM t';
		const ranges = computeCommentRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.substring(ranges[0].start, ranges[0].end)).toBe('-- hello');
	});

	it('detects block comments (/* */)', () => {
		const text = 'SELECT /* a\nb */ 1';
		const ranges = computeCommentRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.substring(ranges[0].start, ranges[0].end)).toBe('/* a\nb */');
	});

	it('detects Jinja comments ({# #})', () => {
		const text = '{# old ref #}\nSELECT 1';
		const ranges = computeCommentRanges(text);
		expect(ranges).toHaveLength(1);
		expect(text.substring(ranges[0].start, ranges[0].end)).toBe('{# old ref #}');
	});

	it('skips comment markers inside string literals', () => {
		const text = 'SELECT \'it\'\'s -- not a comment\'';
		const ranges = computeCommentRanges(text);
		expect(ranges).toHaveLength(0);
	});

	it('handles multiple comment types in one text', () => {
		const text = '-- line\nSELECT /* block */ 1 {# jinja #}';
		const ranges = computeCommentRanges(text);
		expect(ranges).toHaveLength(3);
	});

	it('returns empty array for text with no comments', () => {
		expect(computeCommentRanges('SELECT 1 FROM t')).toHaveLength(0);
	});
});

describe('isOffsetInComment', () => {
	it('returns true for offset inside a comment', () => {
		const text = 'SELECT 1 -- test\nFROM t';
		const ranges = computeCommentRanges(text);
		// offset 11 is inside '-- test'
		expect(isOffsetInComment(11, ranges)).toBe(true);
	});

	it('returns false for offset outside comments', () => {
		const text = 'SELECT 1 -- test\nFROM t';
		const ranges = computeCommentRanges(text);
		// offset 0 is at 'S' in SELECT
		expect(isOffsetInComment(0, ranges)).toBe(false);
		// offset after newline, at 'F' in FROM
		expect(isOffsetInComment(17, ranges)).toBe(false);
	});

	it('returns false for empty ranges', () => {
		expect(isOffsetInComment(5, [])).toBe(false);
	});

	it('handles ref inside Jinja comment', () => {
		const text = '{# {{ ref(\'old_model\') }} #}\nSELECT 1';
		const ranges = computeCommentRanges(text);
		// The ref() at offset 3 should be inside the Jinja comment
		expect(isOffsetInComment(3, ranges)).toBe(true);
		// 'SELECT' at offset 29 should be outside
		expect(isOffsetInComment(29, ranges)).toBe(false);
	});
});

describe('isLinePositionInComment', () => {
	it('detects position after -- on the line', () => {
		expect(isLinePositionInComment('SELECT 1 -- test', 12)).toBe(true);
	});

	it('returns false before -- on the line', () => {
		expect(isLinePositionInComment('SELECT 1 -- test', 4)).toBe(false);
	});

	it('detects position inside {# #} on the line', () => {
		expect(isLinePositionInComment('{# old ref #} SELECT', 5)).toBe(true);
	});

	it('returns false after closed {# #} on same line', () => {
		expect(isLinePositionInComment('{# old ref #} SELECT', 15)).toBe(false);
	});

	it('ignores -- inside string literals', () => {
		expect(isLinePositionInComment('WHERE x = \'a--b\' AND y', 20)).toBe(false);
	});

	it('returns false for clean line', () => {
		expect(isLinePositionInComment('SELECT a, b, c', 6)).toBe(false);
	});
});
