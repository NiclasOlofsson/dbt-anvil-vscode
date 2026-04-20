import { describe, expect, it } from 'vitest';
import { mergeSqlAndJinjaTokens } from '../../ftl/ninja-sql-tokens';
import type { SqlToken } from '../../ftl/parse-result';
import type { JinjaToken } from '../../ftl/jinja-tokenizer';

const sql = (start: number, type = 'VAR'): SqlToken => ({
	type, start, end: start, line: 0, col: start + 1,
});
const jinja = (start: number, type: JinjaToken['type'] = 'jinja_expression_open'): JinjaToken => ({
	type, start, end: start + 1, line: 0, col: start, value: '{{',
});

describe('mergeSqlAndJinjaTokens', () => {
	it('returns empty when both inputs are empty', () => {
		expect(mergeSqlAndJinjaTokens([], [])).toEqual([]);
	});

	it('passes through sql-only stream tagged as category sql', () => {
		const out = mergeSqlAndJinjaTokens([sql(0), sql(5)], []);
		expect(out.map(t => t.category)).toEqual(['sql', 'sql']);
		expect(out.map(t => t.start)).toEqual([0, 5]);
	});

	it('passes through jinja-only stream tagged as category jinja', () => {
		const out = mergeSqlAndJinjaTokens([], [jinja(0), jinja(5)]);
		expect(out.map(t => t.category)).toEqual(['jinja', 'jinja']);
	});

	it('interleaves by start offset preserving source order', () => {
		const out = mergeSqlAndJinjaTokens(
			[sql(0), sql(20), sql(30)],
			[jinja(10), jinja(25)],
		);
		expect(out.map(t => t.start)).toEqual([0, 10, 20, 25, 30]);
		expect(out.map(t => t.category)).toEqual(['sql', 'jinja', 'sql', 'jinja', 'sql']);
	});

	it('puts sql before jinja when start offsets tie (stable on equal keys)', () => {
		const out = mergeSqlAndJinjaTokens([sql(5)], [jinja(5)]);
		expect(out.map(t => t.category)).toEqual(['sql', 'jinja']);
	});

	it('preserves original token shape so consumers can read sql / jinja fields', () => {
		const out = mergeSqlAndJinjaTokens(
			[{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 }],
			[{ type: 'jinja_string', start: 10, end: 14, line: 0, col: 10, value: 'foo' }],
		);
		expect(out[0]).toMatchObject({ category: 'sql', type: 'SELECT', col: 6 });
		expect(out[1]).toMatchObject({ category: 'jinja', type: 'jinja_string', value: 'foo' });
	});

	it('drops sql tokens whose start falls inside a jinja region (blanker placeholder elimination)', () => {
		// Jinja open at offset 10 with tagEnd=22 → region [10, 22).
		// SQL tokens at 12 and 18 (the blanker's placeholder VARs) must be dropped.
		const open: JinjaToken = { type: 'jinja_expression_open', start: 10, end: 12, line: 0, col: 10, value: '{{', tagEnd: 22 };
		const close: JinjaToken = { type: 'jinja_expression_close', start: 20, end: 22, line: 0, col: 20, value: '}}' };
		const out = mergeSqlAndJinjaTokens(
			[sql(0, 'SELECT'), sql(12, 'VAR'), sql(18, 'VAR'), sql(25, 'FROM')],
			[open, close],
		);
		expect(out.map(t => ({ cat: t.category, start: t.start }))).toEqual([
			{ cat: 'sql', start: 0 },
			{ cat: 'jinja', start: 10 },
			{ cat: 'jinja', start: 20 },
			{ cat: 'sql', start: 25 },
		]);
	});

	it('preserves sql tokens that sit exactly at the region end (end is exclusive)', () => {
		const open: JinjaToken = { type: 'jinja_expression_open', start: 10, end: 12, line: 0, col: 10, value: '{{', tagEnd: 20 };
		const close: JinjaToken = { type: 'jinja_expression_close', start: 18, end: 20, line: 0, col: 18, value: '}}' };
		const out = mergeSqlAndJinjaTokens([sql(20, 'FROM')], [open, close]);
		expect(out.map(t => t.category)).toEqual(['jinja', 'jinja', 'sql']);
		expect(out[2].start).toBe(20);
	});

	it('handles multiple jinja regions with sql tokens between them', () => {
		const o1: JinjaToken = { type: 'jinja_expression_open', start: 5, end: 7, line: 0, col: 5, value: '{{', tagEnd: 15 };
		const c1: JinjaToken = { type: 'jinja_expression_close', start: 13, end: 15, line: 0, col: 13, value: '}}' };
		const o2: JinjaToken = { type: 'jinja_expression_open', start: 25, end: 27, line: 0, col: 25, value: '{{', tagEnd: 35 };
		const c2: JinjaToken = { type: 'jinja_expression_close', start: 33, end: 35, line: 0, col: 33, value: '}}' };
		const out = mergeSqlAndJinjaTokens(
			[sql(0), sql(8) /* in region 1 */, sql(20), sql(30) /* in region 2 */, sql(40)],
			[o1, c1, o2, c2],
		);
		expect(out.map(t => ({ cat: t.category, start: t.start }))).toEqual([
			{ cat: 'sql', start: 0 },
			{ cat: 'jinja', start: 5 },
			{ cat: 'jinja', start: 13 },
			{ cat: 'sql', start: 20 },
			{ cat: 'jinja', start: 25 },
			{ cat: 'jinja', start: 33 },
			{ cat: 'sql', start: 40 },
		]);
	});

	it('open tokens carry tagEnd so consumers can skip a region in O(1)', () => {
		const open: JinjaToken = { type: 'jinja_expression_open', start: 0, end: 2, line: 0, col: 0, value: '{{', tagEnd: 20 };
		const close: JinjaToken = { type: 'jinja_expression_close', start: 18, end: 20, line: 0, col: 18, value: '}}' };
		const [merged] = mergeSqlAndJinjaTokens([], [open, close]);
		expect(merged).toMatchObject({ category: 'jinja', type: 'jinja_expression_open', tagEnd: 20 });
	});
});
