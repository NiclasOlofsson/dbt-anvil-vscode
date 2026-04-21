import { describe, it, expect } from 'vitest';
import { Rewriter } from '../../ninja/code-actions/rewriter';

describe('Rewriter', () => {
	it('renders the original text unchanged when no edits are applied', () => {
		const r = new Rewriter('select 1 from t');
		expect(r.render()).toBe('select 1 from t');
	});

	it('applies a single replacement', () => {
		const r = new Rewriter('select foo from t');
		r.apply(7, 10, 'BAR');
		expect(r.render()).toBe('select BAR from t');
	});

	it('applies multiple non-overlapping edits in any order', () => {
		const r = new Rewriter('select foo from t');
		r.apply(16, 17, 'TBL');
		r.apply(7, 10, 'BAR');
		expect(r.render()).toBe('select BAR from TBL');
	});

	it('throws on overlapping edits', () => {
		const r = new Rewriter('select foo');
		r.apply(7, 10, 'BAR');
		expect(() => r.apply(8, 9, 'X')).toThrow(/overlap/);
	});

	it('throws on out-of-bounds edits', () => {
		const r = new Rewriter('abc');
		expect(() => r.apply(-1, 1, 'x')).toThrow(/invalid range/);
		expect(() => r.apply(0, 99, 'x')).toThrow(/invalid range/);
		expect(() => r.apply(2, 1, 'x')).toThrow(/invalid range/);
	});

	it('maps original offsets to current offsets accounting for shifts', () => {
		const r = new Rewriter('select foo from bar');
		// Replace "foo" (3 chars) with "BARBAZ" (6 chars) — net +3.
		r.apply(7, 10, 'BARBAZ');
		expect(r.mapOffset(0)).toBe(0); // before edit, no shift
		expect(r.mapOffset(7)).toBe(7); // start of edit
		expect(r.mapOffset(10)).toBe(13); // just past edit, shifted by +3
		expect(r.mapOffset(15)).toBe(18); // "from" start, shifted by +3
	});

	it('anchors mapOffset for offsets inside a replaced range to the replacement start', () => {
		const r = new Rewriter('select foo from bar');
		r.apply(7, 10, 'BARBAZ');
		// Original offset 8 was inside "foo" — map to start of replacement.
		expect(r.mapOffset(8)).toBe(7);
	});

	it('handles deletions (newText shorter than original)', () => {
		const r = new Rewriter('select  foo  from t');
		r.apply(6, 8, ' '); // collapse double-space → single
		r.apply(11, 13, ' ');
		expect(r.render()).toBe('select foo from t');
	});

	it('cumulativeDelta updates correctly for multiple edits', () => {
		const r = new Rewriter('aaa bbb ccc');
		r.apply(0, 3, 'A'); // -2
		r.apply(8, 11, 'CCCCC'); // +2
		expect(r.render()).toBe('A bbb CCCCC');
		// Offset of "bbb" start in original is 4 → after first edit (-2), it's 2.
		expect(r.mapOffset(4)).toBe(2);
		// Offset just past "bbb" in original is 7 → still shifted by -2.
		expect(r.mapOffset(7)).toBe(5);
		// Offset just past "ccc" in original is 11 → shifted by 0 (-2 +2).
		expect(r.mapOffset(11)).toBe(11);
	});
});
