import { describe, it, expect } from 'vitest';
import { buildLineStarts, lineAtOffset, colAtOffset } from '../../ftl/jinja-spans';

// ── helper offset utilities ───────────────────────────────────────────────

describe('buildLineStarts', () => {
	it('returns [0] for a single-line string', () => {
		expect(buildLineStarts('hello')).toEqual([0]);
	});

	it('returns correct starts for a two-line string', () => {
		// 'abc\ndef' → line 0 starts at 0, line 1 starts at 4
		expect(buildLineStarts('abc\ndef')).toEqual([0, 4]);
	});

	it('handles a trailing newline', () => {
		// 'abc\n' → line 0 at 0, line 1 at 4 (empty line after trailing \n)
		expect(buildLineStarts('abc\n')).toEqual([0, 4]);
	});
});

describe('lineAtOffset / colAtOffset', () => {
	it('returns line 0 and correct col for single-line', () => {
		const ls = buildLineStarts('SELECT id FROM users');
		expect(lineAtOffset(7, ls)).toBe(0);
		expect(colAtOffset(7, ls)).toBe(7);
	});

	it('returns correct line and col on second line', () => {
		// 'abc\ndef' — offset 4 = first char on line 1
		const ls = buildLineStarts('abc\ndef');
		expect(lineAtOffset(4, ls)).toBe(1);
		expect(colAtOffset(4, ls)).toBe(0);
		expect(lineAtOffset(6, ls)).toBe(1);
		expect(colAtOffset(6, ls)).toBe(2);
	});
});
