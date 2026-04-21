import { describe, it, expect } from 'vitest';
import { parseFmtOffRegions, isInFmtOffRegion } from '../../ninja/jinja/directive-parser';

const parse = (text: string) => parseFmtOffRegions(text.split('\n'));

describe('parseFmtOffRegions', () => {
	it('returns empty array when there are no directives', () => {
		const regions = parse('SELECT 1\nFROM t\nWHERE id = 1\n');
		expect(regions).toEqual([]);
	});

	it('creates a closed region between fmt:off and fmt:on', () => {
		const regions = parse([
			'SELECT 1',
			'-- fmt: off',
			'SELECT   2',
			'-- fmt: on',
			'SELECT 3',
		].join('\n'));
		expect(regions).toEqual([[1, 3]]);
	});

	it('open region (no matching fmt:on) extends to end of file', () => {
		const regions = parse([
			'SELECT 1',
			'-- fmt: off',
			'SELECT   2',
			'SELECT   3',
		].join('\n'));
		expect(regions).toEqual([[1, 3]]);
	});

	it('handles multiple non-overlapping regions', () => {
		const regions = parse([
			'SELECT 1',       // 0
			'-- fmt: off',    // 1
			'SELECT   2',     // 2
			'-- fmt: on',     // 3
			'SELECT 4',       // 4
			'-- fmt: off',    // 5
			'SELECT   5',     // 6
			'-- fmt: on',     // 7
		].join('\n'));
		expect(regions).toEqual([[1, 3], [5, 7]]);
	});

	it('ignores a second fmt:off while already inside an off region', () => {
		const regions = parse([
			'-- fmt: off',    // 0
			'SELECT   1',     // 1
			'-- fmt: off',    // 2  (should be ignored)
			'SELECT   2',     // 3
			'-- fmt: on',     // 4
		].join('\n'));
		// The region should start at 0 and close at 4 (the second off is absorbed)
		expect(regions).toEqual([[0, 4]]);
	});

	it('matches directive at end of file without trailing newline', () => {
		const regions = parse('SELECT 1\n-- fmt: off');
		expect(regions).toEqual([[1, 1]]);
	});

	it('is case-insensitive and flexible about whitespace', () => {
		const variants = [
			'--fmt:off',
			'-- FMT: OFF',
			'--fmt: off',
			'-- fmt:off',
			'--  fmt  :  off',
		];
		for (const variant of variants) {
			const regions = parseFmtOffRegions([variant, '-- fmt: on']);
			expect(regions, `failed for variant: ${variant}`).toEqual([[0, 1]]);
		}
	});

	it('allows directive to appear after SQL content on the same line', () => {
		const regions = parse([
			'SELECT 1 -- fmt: off',
			'SELECT 2',
			'SELECT 3 -- fmt: on',
		].join('\n'));
		expect(regions).toEqual([[0, 2]]);
	});

	it('does not match a partial comment that contains fmt off as a substring word', () => {
		// "nofmt:off" should NOT match — the directive requires the `--` prefix
		const regions = parse([
			'SELECT 1  -- nofmt:off',
			'SELECT 2',
		].join('\n'));
		expect(regions).toEqual([]);
	});
});

describe('isInFmtOffRegion', () => {
	const regions: Array<[number, number]> = [[2, 5], [10, 12]];

	it('returns false when there are no regions', () => {
		expect(isInFmtOffRegion(0, [])).toBe(false);
	});

	it('returns false for a line before any region', () => {
		expect(isInFmtOffRegion(1, regions)).toBe(false);
	});

	it('returns true for the first line of a region (inclusive)', () => {
		expect(isInFmtOffRegion(2, regions)).toBe(true);
	});

	it('returns true for a line inside a region', () => {
		expect(isInFmtOffRegion(4, regions)).toBe(true);
	});

	it('returns true for the last line of a region (inclusive)', () => {
		expect(isInFmtOffRegion(5, regions)).toBe(true);
	});

	it('returns false for a line between two regions', () => {
		expect(isInFmtOffRegion(7, regions)).toBe(false);
	});

	it('returns true for a line in the second region', () => {
		expect(isInFmtOffRegion(11, regions)).toBe(true);
	});

	it('returns false for a line after all regions', () => {
		expect(isInFmtOffRegion(20, regions)).toBe(false);
	});
});
