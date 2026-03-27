import { describe, expect, it } from 'vitest';
import { blankJinja } from '../dbt/jinja-blanker';

// Helper: build the expected output for a tag where an identifier is left-aligned
// and the remainder is space-padded.
function padTo(identifier: string, len: number): string {
	return identifier.slice(0, len) + ' '.repeat(Math.max(0, len - identifier.length));
}

describe('blankJinja', () => {
	// ── Length preservation ────────────────────────────────────────────────

	it('preserves string length for a ref tag', () => {
		const sql = '{{ ref(\'orders\') }}';
		expect(blankJinja(sql).length).toBe(sql.length);
	});

	it('preserves string length for a source tag', () => {
		const sql = '{{ source(\'raw\', \'orders\') }}';
		expect(blankJinja(sql).length).toBe(sql.length);
	});

	it('preserves string length for a statement macro tag', () => {
		const sql = '{{ config(materialized=\'table\') }}';
		expect(blankJinja(sql).length).toBe(sql.length);
	});

	it('preserves string length for a block tag', () => {
		const sql = '{% set my_var = \'foo\' %}';
		expect(blankJinja(sql).length).toBe(sql.length);
	});

	it('preserves string length for a comment tag', () => {
		const sql = '{# this is a jinja comment #}';
		expect(blankJinja(sql).length).toBe(sql.length);
	});

	it('preserves string length for an unknown expression tag', () => {
		const sql = '{{ some_variable }}';
		expect(blankJinja(sql).length).toBe(sql.length);
	});

	// ── ref() tags ─────────────────────────────────────────────────────────

	it('replaces ref tag with model name left-aligned, space-padded', () => {
		const tag = '{{ ref(\'orders\') }}';
		expect(blankJinja(tag)).toBe(padTo('orders', tag.length));
	});

	it('handles ref tag embedded in surrounding SQL', () => {
		const tag = '{{ ref(\'stg_orders\') }}';
		const sql = 'select * from ' + tag;
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		expect(result).toBe('select * from ' + padTo('stg_orders', tag.length));
	});

	it('handles ref tag with double quotes', () => {
		const tag = '{{ ref("my_model") }}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result.startsWith('my_model')).toBe(true);
		expect(result.trimEnd()).toBe('my_model');
	});

	// ── source() tags ──────────────────────────────────────────────────────

	it('replaces source tag with table name (2nd arg) left-aligned', () => {
		const tag = '{{ source(\'raw\', \'orders\') }}';
		expect(blankJinja(tag)).toBe(padTo('orders', tag.length));
	});

	it('uses only the table name, not the source name', () => {
		const tag = '{{ source(\'finance\', \'gl_entries\') }}';
		const result = blankJinja(tag);
		expect(result.startsWith('gl_entries')).toBe(true);
		expect(result.trimEnd()).toBe('gl_entries');
	});

	// ── Statement macros → all spaces ──────────────────────────────────────

	it('blanks config() to spaces', () => {
		const tag = '{{ config(materialized=\'table\') }}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks docs() to spaces', () => {
		const tag = '{{ docs(\'my_doc\') }}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks log() to spaces', () => {
		const tag = '{{ log(\'debug message\') }}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks print() to spaces', () => {
		const tag = '{{ print(some_var) }}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks return() to spaces', () => {
		const tag = '{{ return(something) }}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks exceptions() to spaces', () => {
		const tag = '{{ exceptions.raise_compiler_error("msg") }}';
		// MACRO_TAG_RE captures the last name component after '.', which is 'raise_compiler_error'
		// Wait — MACRO_TAG_RE: /^\{\{\s*(?:[a-zA-Z_]\w*\.)*([a-zA-Z_]\w*)\s*\(/
		// For '{{ exceptions.raise_compiler_error("msg") }}':
		//   The prefix group matches 'exceptions.' and captures 'raise_compiler_error', which is NOT in STATEMENT_MACROS.
		//   'exceptions' itself is in STATEMENT_MACROS but MACRO_TAG_RE captures the LAST component.
		// So this tag would be treated as macro name 'raise_compiler_error', not blanked to spaces.
		// This is consistent with the Python bridge behaviour.
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result.startsWith('raise_compiler_error')).toBe(true);
	});

	it('blanks {{ config(...) }} before WITH to spaces so sqlglot sees no stray identifier', () => {
		// Regression captured in bridge-integration tests: config() before `with`
		// must produce pure spaces, not `_`, so sqlglot can parse the file.
		const tag = '{{ config(materialized=\'table\') }}';
		const sql = tag + '\n\nwith orders as (\n    select 1\n)';
		const result = blankJinja(sql);
		// The config tag at the start should be all spaces (no `_`).
		expect(result.slice(0, tag.length)).toBe(' '.repeat(tag.length));
		// The rest of the SQL is unchanged.
		expect(result.slice(tag.length)).toBe('\n\nwith orders as (\n    select 1\n)');
	});

	// ── Block and comment tags → all spaces ───────────────────────────────

	it('blanks block tags to spaces', () => {
		const tag = '{% set my_var = \'foo\' %}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks comment tags to spaces', () => {
		const tag = '{# this is a comment #}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks whitespace-stripped block tags to spaces', () => {
		const tag = '{%- set x = 1 -%}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks whitespace-stripped comment tags to spaces', () => {
		const tag = '{#- trimmed comment -#}';
		expect(blankJinja(tag)).toBe(' '.repeat(tag.length));
	});

	// ── Unknown macro and variable tags ───────────────────────────────────

	it('replaces known macro with name left-aligned', () => {
		const tag = '{{ my_macro(arg) }}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result.startsWith('my_macro')).toBe(true);
		expect(result.trimEnd()).toBe('my_macro');
	});

	it('uses only the last name component for namespaced macros', () => {
		const tag = '{{ ns.macro(arg) }}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result.startsWith('macro')).toBe(true);
		expect(result.trimEnd()).toBe('macro');
	});

	it('uses only the last name component for deeply namespaced macros', () => {
		const tag = '{{ dbt_utils.generate_schema_name(custom_schema) }}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result.startsWith('generate_schema_name')).toBe(true);
	});

	it('replaces bare variable reference with _ followed by spaces', () => {
		const tag = '{{ some_variable }}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result[0]).toBe('_');
		expect(result.slice(1)).toBe(' '.repeat(tag.length - 1));
	});

	it('replaces unknown {{ expr }} with _ as first char', () => {
		const tag = '{{ 42 }}';
		const result = blankJinja(tag);
		expect(result[0]).toBe('_');
		expect(result.length).toBe(tag.length);
	});

	// ── Newline preservation ───────────────────────────────────────────────

	it('preserves newlines inside block tags', () => {
		const tag = '{% if\n  is_incremental()\n%}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		// Newlines stay at their original positions; all other chars become spaces.
		for (let i = 0; i < result.length; i++) {
			if (tag[i] === '\n') {
				expect(result[i]).toBe('\n');
			} else {
				expect(result[i]).toBe(' ');
			}
		}
	});

	it('preserves newlines inside comment tags', () => {
		const tag = '{#\ncomment line 1\ncomment line 2\n#}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result.includes('\n')).toBe(true);
		// Non-newline chars all become spaces.
		for (let i = 0; i < result.length; i++) {
			expect(result[i] === ' ' || result[i] === '\n').toBe(true);
		}
	});

	it('preserves newlines inside expression tags', () => {
		const tag = '{{\n  my_macro(\n    col\n  )\n}}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		// The newlines must stay at the same positions.
		const rawNewlines = [...tag].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		const resNewlines = [...result].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		expect(resNewlines).toEqual(rawNewlines);
	});

	// ── Multi-tag SQL strings ──────────────────────────────────────────────

	it('handles multiple tags in a single SQL string', () => {
		const sql = 'select * from {{ ref(\'orders\') }} o join {{ ref(\'customers\') }} c on o.customer_id = c.id';
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		expect(result.includes('orders')).toBe(true);
		expect(result.includes('customers')).toBe(true);
		// No raw Jinja delimiters remain.
		expect(result.includes('{{')).toBe(false);
	});

	it('handles a mix of block tags and expression tags', () => {
		const sql = '{% set x = \'foo\' %} select {{ ref(\'orders\') }}';
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		expect(result.startsWith(' ')).toBe(true);
		expect(result.includes('orders')).toBe(true);
		expect(result.includes('{{')).toBe(false);
		expect(result.includes('{%')).toBe(false);
	});

	it('replaces all tags independently without interfering with each other', () => {
		const ref1 = '{{ ref(\'aaa\') }}';
		const ref2 = '{{ ref(\'bbb\') }}';
		const sql = ref1 + ' join ' + ref2;
		const result = blankJinja(sql);
		expect(result.slice(0, ref1.length)).toBe(padTo('aaa', ref1.length));
		expect(result.slice(ref1.length + ' join '.length)).toBe(padTo('bbb', ref2.length));
	});

	// ── No-op cases ───────────────────────────────────────────────────────

	it('returns plain SQL unchanged', () => {
		const sql = 'select order_id, amount from raw_orders where status = \'shipped\'';
		expect(blankJinja(sql)).toBe(sql);
	});

	it('returns an empty string unchanged', () => {
		expect(blankJinja('')).toBe('');
	});
});
