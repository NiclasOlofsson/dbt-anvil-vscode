import { describe, it, expect } from 'vitest';
import { extractJinjaSpans, buildLineStarts, lineAtOffset, colAtOffset } from '../../ftl/jinja-spans';

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

// ── extractJinjaSpans ────────────────────────────────────────────────────

describe('extractJinjaSpans', () => {
	it('returns empty array when there are no Jinja tags', () => {
		expect(extractJinjaSpans('SELECT id FROM orders')).toEqual([]);
	});

	it('returns empty array for non-ref/source Jinja expression tags', () => {
		expect(extractJinjaSpans('{{ config(materialized=\'table\') }}')).toEqual([]);
		expect(extractJinjaSpans('{{ var(\'my_var\') }}')).toEqual([]);
	});

	it('skips {% %} block tags', () => {
		expect(extractJinjaSpans('{% set x = 1 %}\nSELECT 1')).toEqual([]);
	});

	it('skips {# #} comment tags', () => {
		expect(extractJinjaSpans('{# a comment #}\nSELECT 1')).toEqual([]);
	});

	// ── ref() ──────────────────────────────────────────────────────────────

	it('extracts a single-quoted ref tag on line 0', () => {
		// Positions:
		//   S(0)E(1)L(2)E(3)C(4)T(5) (6)*(7) (8)F(9)R(10)O(11)M(12) (13){(14){(15) (16)r(17)e(18)f(19)((20)'(21)o(22)r(23)d(24)e(25)r(26)s(27)'(28))(29) (30)}(31)}(32)
		const sql = 'SELECT * FROM {{ ref(\'orders\') }}';
		const spans = extractJinjaSpans(sql);

		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.type).toBe('ref');
		if (span.type !== 'ref') return;

		expect(span.line).toBe(0);
		expect(span.model).toBe('orders');
		// 'r' in ref( is at offset 17 → col 17
		expect(span.col).toBe(17);
		// model name 'orders' starts at offset 22 (after "ref('")
		expect(span.modelCol).toBe(22);
		// closing quote is at offset 28 (exclusive end of model name content)
		expect(span.modelEndCol).toBe(28);
		// '{{' starts at offset 14
		expect(span.jinjaCol).toBe(14);
		// exclusive end: offset 14 + tag length 19 = 33
		expect(span.jinjaEndCol).toBe(33);
	});

	it('extracts a double-quoted ref tag', () => {
		// Same positions as single-quoted — quote char is different but lengths match.
		const sql = 'SELECT * FROM {{ ref("orders") }}';
		const spans = extractJinjaSpans(sql);

		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.type).toBe('ref');
		if (span.type !== 'ref') return;

		expect(span.model).toBe('orders');
		expect(span.line).toBe(0);
		expect(span.col).toBe(17);
		expect(span.modelCol).toBe(22);
		expect(span.modelEndCol).toBe(28);
		expect(span.jinjaCol).toBe(14);
		expect(span.jinjaEndCol).toBe(33);
	});

	it('extracts a ref tag on line N (multi-line SQL)', () => {
		// Line 0: 'WITH orders AS (' = 16 chars + \n → lineStarts[1] = 17
		// Line 1: '    SELECT * FROM {{ ref(\'stg_orders\') }}'
		//   Cols:  0123456789...
		//   4 spaces + 'SELECT * FROM ' (14 chars) = 18 chars before '{{'
		//   '{{' is at col 18 on line 1 → abs offset 17+18 = 35
		//   'ref(' is at col 21 (offset 35+3=38 abs, 38-17=21 col)
		//   'stg_orders': 10 chars, opens at col 26 (38-17+5... let me compute:
		//     tag = '{{ ref(\'stg_orders\') }}'
		//       {(0){(1) (2)r(3)e(4)f(5)((6)'(7)s(8)t(9)g(10)_(11)o(12)r(13)d(14)e(15)r(16)s(17)'(18))(19) (20)}(21)}(22)
		//     arg.relStart=8, arg.relEnd=18
		//     modelCol = col(35+8) = col(43) = 43-17 = 26
		//     modelEndCol = col(35+18) = col(53) = 53-17 = 36
		const sql = [
			'WITH orders AS (',
			'    SELECT * FROM {{ ref(\'stg_orders\') }}',
			')',
		].join('\n');
		const spans = extractJinjaSpans(sql);

		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.type).toBe('ref');
		if (span.type !== 'ref') return;

		expect(span.line).toBe(1);
		expect(span.model).toBe('stg_orders');
		expect(span.col).toBe(21);
		expect(span.modelCol).toBe(26);
		expect(span.modelEndCol).toBe(36);
		expect(span.jinjaCol).toBe(18);
		expect(span.jinjaEndCol).toBe(41);
	});

	// ── source() ───────────────────────────────────────────────────────────

	it('extracts a source tag', () => {
		// '{{ source(\'raw\', \'orders\') }}'
		//   {(0){(1) (2)s(3)o(4)u(5)r(6)c(7)e(8)((9)'(10)r(11)a(12)w(13)'(14),(15) (16)'(17)o(18)r(19)d(20)e(21)r(22)s(23)'(24))(25) (26)}(27)}(28)
		//   srcIdx=3, callAbsOffset=0+3=3, line=0, col=3
		//   arg1: relStart=11, relEnd=14 → sourceNameCol=11, sourceNameEndCol=14
		//   arg2: relStart=18, relEnd=24 → tableNameCol=18, tableNameEndCol=24
		//   jinjaCol=0, jinjaEndCol=29
		const sql = '{{ source(\'raw\', \'orders\') }}';
		const spans = extractJinjaSpans(sql);

		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.type).toBe('source');
		if (span.type !== 'source') return;

		expect(span.line).toBe(0);
		expect(span.col).toBe(3);
		expect(span.sourceName).toBe('raw');
		expect(span.tableName).toBe('orders');
		expect(span.sourceNameCol).toBe(11);
		expect(span.sourceNameEndCol).toBe(14);
		expect(span.tableNameCol).toBe(18);
		expect(span.tableNameEndCol).toBe(24);
		expect(span.jinjaCol).toBe(0);
		expect(span.jinjaEndCol).toBe(29);
	});

	it('extracts a source tag with double-quoted args', () => {
		const sql = '{{ source("raw", "orders") }}';
		const spans = extractJinjaSpans(sql);

		expect(spans).toHaveLength(1);
		const span = spans[0];
		expect(span.type).toBe('source');
		if (span.type !== 'source') return;

		expect(span.sourceName).toBe('raw');
		expect(span.tableName).toBe('orders');
	});

	// ── multiple / mixed ───────────────────────────────────────────────────

	it('extracts multiple ref tags in one SQL', () => {
		const sql = [
			'SELECT * FROM {{ ref(\'customers\') }} AS c',
			'JOIN {{ ref(\'orders\') }} AS o ON c.id = o.user_id',
		].join('\n');
		const spans = extractJinjaSpans(sql);

		expect(spans).toHaveLength(2);
		expect(spans[0].type).toBe('ref');
		expect(spans[1].type).toBe('ref');
		if (spans[0].type !== 'ref' || spans[1].type !== 'ref') return;

		expect(spans[0].model).toBe('customers');
		expect(spans[0].line).toBe(0);
		expect(spans[1].model).toBe('orders');
		expect(spans[1].line).toBe(1);
	});

	it('extracts a mix of ref and source tags', () => {
		const sql = [
			'SELECT * FROM {{ source(\'raw\', \'customers\') }} AS c',
			'JOIN {{ ref(\'stg_orders\') }} AS o ON c.id = o.user_id',
		].join('\n');
		const spans = extractJinjaSpans(sql);

		expect(spans).toHaveLength(2);
		expect(spans[0].type).toBe('source');
		expect(spans[1].type).toBe('ref');
	});

	it('does not match a config() tag that happens to contain the word ref', () => {
		// 'ref_table' inside config value — no actual ref() call
		const sql = '{{ config(alias=\'ref_table\') }}\nSELECT 1';
		expect(extractJinjaSpans(sql)).toEqual([]);
	});
});
