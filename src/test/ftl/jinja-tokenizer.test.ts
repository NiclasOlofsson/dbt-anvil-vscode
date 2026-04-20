import { describe, expect, it } from 'vitest';
import { tokenizeJinja, type JinjaToken } from '../../ftl/jinja-tokenizer';

const types = (toks: JinjaToken[]) => toks.map(t => t.type);
const values = (toks: JinjaToken[]) => toks.map(t => t.value);

describe('tokenizeJinja', () => {
	it('returns no tokens for SQL with no jinja', () => {
		expect(tokenizeJinja('SELECT 1')).toEqual([]);
	});

	it('tokenizes a {{ ref(\'model\') }} expression', () => {
		const toks = tokenizeJinja('SELECT * FROM {{ ref(\'orders\') }}');
		expect(types(toks)).toEqual([
			'jinja_expression_open',
			'jinja_identifier',
			'jinja_paren_open',
			'jinja_string',
			'jinja_paren_close',
			'jinja_expression_close',
		]);
		expect(values(toks)).toEqual(['{{', 'ref', '(', 'orders', ')', '}}']);
	});

	it('tokenizes a {{ source(\'ns\', \'tbl\') }} expression', () => {
		const toks = tokenizeJinja('SELECT 1 FROM {{ source(\'raw\', \'orders\') }}');
		expect(types(toks)).toEqual([
			'jinja_expression_open',
			'jinja_identifier',
			'jinja_paren_open',
			'jinja_string',
			'jinja_comma',
			'jinja_string',
			'jinja_paren_close',
			'jinja_expression_close',
		]);
		expect(values(toks)).toEqual(['{{', 'source', '(', 'raw', ',', 'orders', ')', '}}']);
	});

	it('tokenizes a namespaced macro call (dbt_utils.foo)', () => {
		const toks = tokenizeJinja('{{ dbt_utils.star(ref(\'x\')) }}');
		expect(types(toks)).toEqual([
			'jinja_expression_open',
			'jinja_identifier', // dbt_utils
			'jinja_dot',
			'jinja_identifier', // star
			'jinja_paren_open',
			'jinja_identifier', // ref
			'jinja_paren_open',
			'jinja_string',
			'jinja_paren_close',
			'jinja_paren_close',
			'jinja_expression_close',
		]);
	});

	it('records 0-based line/col offsets', () => {
		const toks = tokenizeJinja('SELECT * FROM {{ ref(\'x\') }}');
		const refIdent = toks.find(t => t.type === 'jinja_identifier' && t.value === 'ref')!;
		expect(refIdent.line).toBe(0);
		expect(refIdent.col).toBe(17);
		expect(refIdent.start).toBe(17);
		expect(refIdent.end).toBe(20);
	});

	it('handles a string with quotes correctly (excludes quotes from value, includes them in offsets)', () => {
		const sql = '{{ ref(\'my_model\') }}';
		const toks = tokenizeJinja(sql);
		const str = toks.find(t => t.type === 'jinja_string')!;
		expect(str.value).toBe('my_model');
		// start points at the opening quote, end points past the closing quote
		expect(sql.slice(str.start, str.end)).toBe('\'my_model\'');
	});

	it('handles double-quoted strings', () => {
		const toks = tokenizeJinja('{{ ref("my_model") }}');
		const str = toks.find(t => t.type === 'jinja_string')!;
		expect(str.value).toBe('my_model');
	});

	it('tokenizes block tags with full inner tokenization (same grammar as expressions)', () => {
		const toks = tokenizeJinja('{% if condition %}SELECT 1{% endif %}');
		expect(types(toks)).toEqual([
			'jinja_block_open',
			'jinja_identifier', // if
			'jinja_identifier', // condition
			'jinja_block_close',
			'jinja_block_open',
			'jinja_identifier', // endif
			'jinja_block_close',
		]);
		expect(values(toks)).toEqual(['{%', 'if', 'condition', '%}', '{%', 'endif', '%}']);
	});

	it('tokenizes a {% set %} block with assignment and ref call', () => {
		const toks = tokenizeJinja('{% set x = ref(\'orders\') %}');
		expect(types(toks)).toEqual([
			'jinja_block_open',
			'jinja_identifier', // set
			'jinja_identifier', // x
			'jinja_operator',   // =
			'jinja_identifier', // ref
			'jinja_paren_open',
			'jinja_string',
			'jinja_paren_close',
			'jinja_block_close',
		]);
		expect(values(toks)).toEqual(['{%', 'set', 'x', '=', 'ref', '(', 'orders', ')', '%}']);
	});

	it('tokenizes comment tags as opaque text between comment markers', () => {
		const toks = tokenizeJinja('{# this is a comment #}');
		expect(types(toks)).toEqual(['jinja_comment_open', 'jinja_text', 'jinja_comment_close']);
		expect(values(toks)).toEqual(['{#', 'this is a comment', '#}']);
	});

	it('tokenizes numbers', () => {
		const toks = tokenizeJinja('{{ var(\'x\', 42) }}');
		const num = toks.find(t => t.type === 'jinja_number')!;
		expect(num.value).toBe('42');
	});

	it('emits jinja_operator for punctuation (e.g. pipe filter)', () => {
		const toks = tokenizeJinja('{{ name | upper }}');
		expect(types(toks)).toEqual([
			'jinja_expression_open',
			'jinja_identifier',
			'jinja_operator',
			'jinja_identifier',
			'jinja_expression_close',
		]);
		expect(values(toks)).toEqual(['{{', 'name', '|', 'upper', '}}']);
	});

	it('handles nested {{ }} in string args (e.g. config(post_hook="{{ this }}"))', () => {
		// iterJinjaTags treats the outer call as one tag thanks to depth-counting.
		const toks = tokenizeJinja('{{ config(post_hook="COPY {{ this }} TO out") }}');
		// Outer tag should produce open/close once.
		expect(toks.filter(t => t.type === 'jinja_expression_open')).toHaveLength(1);
		expect(toks.filter(t => t.type === 'jinja_expression_close')).toHaveLength(1);
		// The inner {{ this }} sits inside a string arg, so it's part of the string value.
		const str = toks.find(t => t.type === 'jinja_string')!;
		expect(str.value).toBe('COPY {{ this }} TO out');
	});

	it('handles multi-line tags — line/col tracks each token correctly', () => {
		const sql = [
			'{{ config(',
			'  materialized=\'table\'',
			') }}',
		].join('\n');
		const toks = tokenizeJinja(sql);
		const open = toks.find(t => t.type === 'jinja_expression_open')!;
		const close = toks.find(t => t.type === 'jinja_expression_close')!;
		expect(open.line).toBe(0);
		expect(close.line).toBe(2);
		expect(close.col).toBe(2); // the } in `) }}` sits at col 2 of line 2
	});

	it('tokens are emitted in source order (interleavable with sqlTokens by start)', () => {
		const toks = tokenizeJinja('{{ ref(\'a\') }} JOIN {{ ref(\'b\') }}');
		for (let i = 1; i < toks.length; i++) {
			expect(toks[i].start).toBeGreaterThanOrEqual(toks[i - 1].start);
		}
	});

	it('tag-open tokens carry tagEnd pointing past the matching close', () => {
		const sql = 'SELECT * FROM {{ ref(\'orders\') }} JOIN {% if x %}b{% endif %} c -- {# trailing #}';
		const toks = tokenizeJinja(sql);
		const tagOpenTypes = ['jinja_expression_open', 'jinja_block_open', 'jinja_comment_open'] as const;
		const tagOpens = toks.filter(t => (tagOpenTypes as readonly string[]).includes(t.type));
		expect(tagOpens.length).toBe(4);
		for (const open of tagOpens) {
			expect(open.tagEnd).toBeDefined();
			const region = sql.slice(open.start, open.tagEnd);
			if (open.type === 'jinja_expression_open') expect(region.endsWith('}}')).toBe(true);
			if (open.type === 'jinja_block_open') expect(region.endsWith('%}')).toBe(true);
			if (open.type === 'jinja_comment_open') expect(region.endsWith('#}')).toBe(true);
			expect(region.startsWith(open.value)).toBe(true);
		}
		// No other token types carry tagEnd.
		for (const t of toks.filter(t => !(tagOpenTypes as readonly string[]).includes(t.type))) {
			expect(t.tagEnd).toBeUndefined();
		}
	});

	it('handles multiple expression tags on the same line', () => {
		const toks = tokenizeJinja('{{ a }} {{ b }}');
		const idents = toks.filter(t => t.type === 'jinja_identifier');
		expect(idents.map(t => t.value)).toEqual(['a', 'b']);
	});

	it('tokenizes a {{ var(\'x\') }} expression as identifier+paren+string+paren', () => {
		const toks = tokenizeJinja('{{ var(\'environment\') }}');
		expect(types(toks)).toEqual([
			'jinja_expression_open',
			'jinja_identifier',
			'jinja_paren_open',
			'jinja_string',
			'jinja_paren_close',
			'jinja_expression_close',
		]);
		expect(values(toks).slice(1, -1)).toEqual(['var', '(', 'environment', ')']);
	});

	it('surfaces whitespace-control hyphens as jinja_operator tokens', () => {
		const toks = tokenizeJinja('{{- name -}}');
		expect(types(toks)).toEqual([
			'jinja_expression_open',
			'jinja_operator',
			'jinja_identifier',
			'jinja_operator',
			'jinja_expression_close',
		]);
	});
});
