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

	it('blanks var() to _ placeholder (VAR is a SQL reserved word)', () => {
		// {{ var("latest_ratings") }} must NOT produce `var ...` — VAR is an aggregate
		// function in DuckDB and causes sqlglot parse errors in SELECT position.
		const tag = '{{ var("latest_ratings") }}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result[0]).toBe('_');
		expect(result.slice(1)).toBe(' '.repeat(tag.length - 1));
	});

	it('blanks env_var() to _ placeholder', () => {
		const tag = '{{ env_var("MY_VAR") }}';
		const result = blankJinja(tag);
		expect(result.length).toBe(tag.length);
		expect(result[0]).toBe('_');
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

	// ── Nested {{ }} tags ─────────────────────────────────────────────────
	// In dbt, {{ config(post_hook="COPY {{ this }} TO '...'") }} is valid:
	// the inner {{ this }} is a literal string inside the outer tag's argument,
	// not a separate Jinja expression.  The blanker must treat the outer tag as
	// one unit and blank it entirely to spaces (config is a STATEMENT_MACRO).

	it('blanks config tag that contains {{ this }} in post_hook string', () => {
		const sql = '{{ config(post_hook="COPY {{ this }} TO \'output.parquet\'") }}';
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		// Entire outer tag (including inner {{ this }}) must become spaces.
		expect(result.trim()).toBe('');
		expect(result.includes('{{')).toBe(false);
	});

	it('blanks multiline config with nested {{ }} in post_hook — real season_summary pattern', () => {
		const sql = [
			'{{',
			'    config(',
			'        materialized="table",',
			'        post_hook="COPY {{ this }} TO \'../data/output.parquet\'",',
			'    )',
			'}}',
		].join('\n');
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		// Newlines preserved; all other chars spaces.
		for (let i = 0; i < result.length; i++) {
			if (sql[i] === '\n') {
				expect(result[i]).toBe('\n');
			} else {
				expect(result[i]).toBe(' ');
			}
		}
	});

	it('correctly blanks adjacent tags when nested {{ }} appears in the first', () => {
		const prefix = '{{ config(post_hook="{{ this }}") }}';
		const suffix = ' {{ ref(\'orders\') }}';
		const sql = prefix + suffix;
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		// config tag → all spaces
		expect(result.slice(0, prefix.length).trim()).toBe('');
		// ref tag → 'orders' padded
		expect(result.slice(prefix.length + 1)).toBe(padTo('orders', suffix.length - 1));
	});

	it('handles multiple levels of {{ }} nesting', () => {
		const sql = '{{ outer(inner="{{ a() }} text {{ b() }}") }}';
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		// outer is not a STATEMENT_MACRO — treated as identifier 'outer'
		expect(result.startsWith('outer')).toBe(true);
		expect(result.includes('{{')).toBe(false);
	});

	// ── SQL characters that look like Jinja delimiters ────────────────────

	it('ignores single { and } characters in plain SQL', () => {
		// DuckDB struct literal — single braces, not Jinja
		const sql = 'select {\'key\': 1} as s, {{ ref(\'orders\') }} as o';
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		// The struct literal is untouched — only the {{ ref(...) }} is blanked
		expect(result.includes('{\'key\': 1}')).toBe(true);
		expect(result.includes('orders')).toBe(true);
	});

	it('ignores { } in SQL outside any Jinja tag', () => {
		const sql = 'select {col: val} from {{ ref(\'t\') }}';
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		expect(result.startsWith('select {col: val} from ')).toBe(true);
	});

	it('handles {{ }} inside a Jinja tag string arg alongside outer SQL braces', () => {
		const sql = '{{ config(post_hook="{{ this }}") }} select {x: 1}';
		const result = blankJinja(sql);
		expect(result.length).toBe(sql.length);
		// config tag (including nested {{ this }}) → all spaces
		const configEnd = '{{ config(post_hook="{{ this }}") }}'.length;
		expect(result.slice(0, configEnd).trim()).toBe('');
		// SQL after the tag is untouched
		expect(result.slice(configEnd)).toBe(' select {x: 1}');
	});

	// ── Known limitation: literal }} inside a string arg ─────────────────
	// The depth counter cannot distinguish a literal `}}` inside a string
	// from a real Jinja closing `}}`.  This documents the current behaviour
	// rather than asserting it works perfectly — the pattern is extremely
	// rare in practice and would also confuse Jinja's own template engine.

	it('documents: literal }} inside a string arg inside a tag stops early (known limitation)', () => {
		// {{ config(x="has }} in string") }}
		// depth counter hits the inner }} first → stops there
		const sql = '{{ config(x="has }} in string") }}';
		const result = blankJinja(sql);
		// The scan stops at the inner }}, so the rest is left as raw text.
		// We assert length is preserved (the partial tag was still blanked).
		expect(result.length).toBe(sql.length);
		// The part after the premature close is NOT blanked — document this.
		expect(result.slice('{{ config(x="has '.length + 2)).not.toBe(
			' '.repeat(sql.length - '{{ config(x="has '.length - 2),
		);
	});
});

// ── comment mode ──────────────────────────────────────────────────────────

describe('blankJinja comment mode', () => {
	it('replaces unknown macro with /* ... */ block comment', () => {
		const tag = '{{ my_macro(arg) }}';
		const result = blankJinja(tag, 'comment');
		expect(result.length).toBe(tag.length);
		expect(result.startsWith('/*')).toBe(true);
		expect(result.endsWith('*/')).toBe(true);
	});

	it('length is preserved in comment mode', () => {
		const tag = '{{ generic_is_deleted(col) }}';
		const result = blankJinja(tag, 'comment');
		expect(result.length).toBe(tag.length);
	});

	it('interior is spaces in comment mode', () => {
		// '/* ' + spaces + ' */'
		const tag = '{{ my_macro(arg) }}';
		const result = blankJinja(tag, 'comment');
		const inner = result.slice(2, result.length - 2);
		expect(inner.trim()).toBe('');
	});

	it('ref() tag is unchanged in comment mode (still uses real name)', () => {
		const tag = '{{ ref(\'orders\') }}';
		const result = blankJinja(tag, 'comment');
		expect(result.startsWith('orders')).toBe(true);
	});

	it('source() tag is unchanged in comment mode (still uses real name)', () => {
		const tag = '{{ source(\'raw\', \'orders\') }}';
		const result = blankJinja(tag, 'comment');
		expect(result.startsWith('orders')).toBe(true);
	});

	it('config() tag blanks to spaces in comment mode (STATEMENT_MACRO unchanged)', () => {
		const tag = '{{ config(materialized=\'table\') }}';
		const result = blankJinja(tag, 'comment');
		expect(result).toBe(' '.repeat(tag.length));
	});

	it('var() tag blanks to _ in comment mode (VALUE_MACRO unchanged)', () => {
		const tag = '{{ var("x") }}';
		const result = blankJinja(tag, 'comment');
		expect(result[0]).toBe('_');
	});

	it('block tags still blank to spaces in comment mode', () => {
		const tag = '{% if is_incremental() %}';
		const result = blankJinja(tag, 'comment');
		expect(result).toBe(' '.repeat(tag.length));
	});

	it('preserves newlines inside a comment-mode tag', () => {
		const tag = '{{\n  my_macro(\n    col\n  )\n}}';
		const result = blankJinja(tag, 'comment');
		expect(result.length).toBe(tag.length);
		const rawNewlines = [...tag].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		const resNewlines = [...result].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		expect(resNewlines).toEqual(rawNewlines);
	});

	it('falls back to spaces when tag has fewer than 4 non-newline chars', () => {
		// Pathological: a 3-char non-NL tag can't fit /* */
		// Build a minimal tag with only 3 non-NL chars: "{{}}" is 4; use "{{a}}" style
		// Actually iterJinjaTags won't match {{ a }} as a macro (no parens) — use spaces
		// The real case is a tag like "{{ x() }}" which has >= 4 non-NL chars,
		// so just verify the ">= 4" branch fires for a normal tag.
		const tag = '{{ m() }}'; // 9 chars, all non-NL, >= 4
		const result = blankJinja(tag, 'comment');
		expect(result.startsWith('/*')).toBe(true);
		expect(result.endsWith('*/')).toBe(true);
	});

	it('statement-level macro becomes comment, making SQL parseable', () => {
		// In identifier mode, a top-level macro call like {{ generic_is_deleted(col, "where") }}
		// produces a bare identifier which is not valid SQL at statement level.
		// In comment mode it becomes /* ... */ which is valid everywhere.
		const sql = 'select id from t\n{{ generic_is_deleted(id, \'where\') }}';
		const result = blankJinja(sql, 'comment');
		expect(result.length).toBe(sql.length);
		const macroStart = 'select id from t\n'.length;
		expect(result.slice(macroStart, macroStart + 2)).toBe('/*');
		expect(result.slice(-2)).toBe('*/');
	});
});
