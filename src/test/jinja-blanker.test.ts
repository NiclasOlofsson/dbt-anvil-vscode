import { describe, expect, it } from 'vitest';
import { blankJinja, makeJinjaId } from '../dbt/jinja-blanker';

// Convenience: return just the blanked string (tests that don't need the idMap).
const b = (sql: string, mode?: 'identifier' | 'comment') => blankJinja(sql, mode).blanked;

// Helper: build the expected output for a tag where an identifier is left-aligned
// and the remainder is space-padded.
function padTo(identifier: string, len: number): string {
	return identifier.slice(0, len) + ' '.repeat(Math.max(0, len - identifier.length));
}

describe('blankJinja', () => {
	// ── Length preservation ────────────────────────────────────────────────

	it('preserves string length for a ref tag', () => {
		expect(b('{{ ref(\'orders\') }}')).toHaveLength('{{ ref(\'orders\') }}'.length);
	});

	it('preserves string length for a source tag', () => {
		const sql = '{{ source(\'raw\', \'orders\') }}';
		expect(b(sql)).toHaveLength(sql.length);
	});

	it('preserves string length for a statement macro tag', () => {
		const sql = '{{ config(materialized=\'table\') }}';
		expect(b(sql)).toHaveLength(sql.length);
	});

	it('preserves string length for a block tag', () => {
		const sql = '{% set my_var = \'foo\' %}';
		expect(b(sql)).toHaveLength(sql.length);
	});

	it('preserves string length for a comment tag', () => {
		const sql = '{# this is a jinja comment #}';
		expect(b(sql)).toHaveLength(sql.length);
	});

	it('preserves string length for an unknown expression tag', () => {
		const sql = '{{ some_variable }}';
		expect(b(sql)).toHaveLength(sql.length);
	});

	it('preserves string length for an unknown macro tag', () => {
		const sql = '{{ my_macro(arg) }}';
		expect(b(sql)).toHaveLength(sql.length);
	});

	// ── ref() tags ─────────────────────────────────────────────────────────

	it('replaces ref tag with model name left-aligned, space-padded', () => {
		const tag = '{{ ref(\'orders\') }}';
		expect(b(tag)).toBe(padTo('orders', tag.length));
	});

	it('handles ref tag embedded in surrounding SQL', () => {
		const tag = '{{ ref(\'stg_orders\') }}';
		const sql = 'select * from ' + tag;
		expect(b(sql)).toBe('select * from ' + padTo('stg_orders', tag.length));
	});

	it('handles ref tag with double quotes', () => {
		const tag = '{{ ref("my_model") }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith('my_model')).toBe(true);
		expect(result.trimEnd()).toBe('my_model');
	});

	// ── source() tags ──────────────────────────────────────────────────────

	it('replaces source tag with table name (2nd arg) left-aligned', () => {
		const tag = '{{ source(\'raw\', \'orders\') }}';
		expect(b(tag)).toBe(padTo('orders', tag.length));
	});

	it('uses only the table name, not the source name', () => {
		const tag = '{{ source(\'finance\', \'gl_entries\') }}';
		const result = b(tag);
		expect(result.startsWith('gl_entries')).toBe(true);
		expect(result.trimEnd()).toBe('gl_entries');
	});

	// ── Statement macros → all spaces ──────────────────────────────────────

	it('blanks config() to spaces', () => {
		const tag = '{{ config(materialized=\'table\') }}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks docs() to spaces', () => {
		const tag = '{{ docs(\'my_doc\') }}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks log() to spaces', () => {
		const tag = '{{ log(\'debug message\') }}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks print() to spaces', () => {
		const tag = '{{ print(some_var) }}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks return() to spaces', () => {
		const tag = '{{ return(something) }}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks {{ config(...) }} before WITH to spaces so sqlglot sees no stray identifier', () => {
		const tag = '{{ config(materialized=\'table\') }}';
		const sql = tag + '\n\nwith orders as (\n    select 1\n)';
		const result = b(sql);
		expect(result.slice(0, tag.length)).toBe(' '.repeat(tag.length));
		expect(result.slice(tag.length)).toBe('\n\nwith orders as (\n    select 1\n)');
	});

	// ── Unknown macros and variables → unique IDs ──────────────────────────
	// Unknown callables (including var/env_var) now emit a guaranteed-unique
	// synthetic identifier __j0__, __j1__, … in base-62, preventing collisions
	// with real CTE or table names in the blanked SQL.

	it('replaces unknown macro with a unique ID, space-padded', () => {
		const tag = '{{ my_macro(arg) }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		const id = makeJinjaId(0);
		expect(result.startsWith(id)).toBe(true);
		// No macro name leaks through.
		expect(result).not.toContain('my_macro');
	});

	it('uses only a unique ID for namespaced macros (not the name component)', () => {
		const tag = '{{ ns.macro(arg) }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
		expect(result).not.toContain('macro');
	});

	it('uses a unique ID for deeply namespaced macros', () => {
		const tag = '{{ dbt_utils.generate_schema_name(custom_schema) }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
		expect(result).not.toContain('generate_schema_name');
	});

	it('replaces var() with a unique ID (not _ or "var")', () => {
		// Previously var() produced `_` to avoid the VAR aggregate keyword in DuckDB.
		// Now it gets a unique ID, which is also a safe SQL identifier and never
		// collides with a real CTE name.
		const tag = '{{ var("latest_ratings") }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
		expect(result).not.toContain('var');
	});

	it('replaces env_var() with a unique ID', () => {
		const tag = '{{ env_var("MY_VAR") }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
	});

	it('replaces bare variable reference with a unique ID', () => {
		const tag = '{{ some_variable }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
	});

	it('replaces unknown {{ expr }} with a unique ID', () => {
		const tag = '{{ 42 }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
	});

	it('replaces exceptions.raise_compiler_error with a unique ID', () => {
		// MACRO_TAG_RE captures 'raise_compiler_error' — not in STATEMENT_MACROS,
		// so it gets a unique ID rather than the name.
		const tag = '{{ exceptions.raise_compiler_error("msg") }}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
		expect(result).not.toContain('raise_compiler_error');
	});

	it('assigns different IDs to multiple unknown macros (counter increments)', () => {
		const sql = '{{ macro_a() }} and {{ macro_b() }}';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		const id0 = makeJinjaId(0);
		const id1 = makeJinjaId(1);
		expect(result).toContain(id0);
		expect(result).toContain(id1);
		// Two distinct IDs.
		expect(id0).not.toBe(id1);
	});

	// ── idMap ──────────────────────────────────────────────────────────────

	it('idMap contains one entry per unique-ID replacement', () => {
		const sql = '{{ my_macro() }} and {{ var("x") }}';
		const { idMap } = blankJinja(sql);
		expect(idMap.size).toBe(2);
	});

	it('idMap keys match the IDs written into the blanked string', () => {
		const tag = '{{ my_macro(arg) }}';
		const { blanked, idMap } = blankJinja(tag);
		const id = makeJinjaId(0);
		expect(blanked.startsWith(id)).toBe(true);
		expect(idMap.has(id)).toBe(true);
	});

	it('idMap values carry the original tag text and source offsets', () => {
		const prefix = 'SELECT ';
		const tag = '{{ my_macro() }}';
		const sql = prefix + tag;
		const { idMap } = blankJinja(sql);
		const info = idMap.get(makeJinjaId(0))!;
		expect(info.original).toBe(tag);
		expect(info.start).toBe(prefix.length);
		expect(info.end).toBe(prefix.length + tag.length);
	});

	it('idMap does NOT contain entries for ref/source (they keep real names)', () => {
		const sql = '{{ ref(\'orders\') }} join {{ source(\'raw\', \'events\') }}';
		const { idMap } = blankJinja(sql);
		expect(idMap.size).toBe(0);
	});

	it('idMap does NOT contain entries for statement macros (blanked to spaces)', () => {
		const { idMap } = blankJinja('{{ config(materialized=\'table\') }}');
		expect(idMap.size).toBe(0);
	});

	// ── Block and comment tags → all spaces ───────────────────────────────

	it('blanks block tags to spaces', () => {
		const tag = '{% set my_var = \'foo\' %}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks comment tags to spaces', () => {
		const tag = '{# this is a comment #}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks whitespace-stripped block tags to spaces', () => {
		const tag = '{%- set x = 1 -%}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	it('blanks whitespace-stripped comment tags to spaces', () => {
		const tag = '{#- trimmed comment -#}';
		expect(b(tag)).toBe(' '.repeat(tag.length));
	});

	// ── Newline preservation ───────────────────────────────────────────────

	it('preserves newlines inside block tags', () => {
		const tag = '{% if\n  is_incremental()\n%}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		for (let i = 0; i < result.length; i++) {
			if (tag[i] === '\n') expect(result[i]).toBe('\n');
			else expect(result[i]).toBe(' ');
		}
	});

	it('preserves newlines inside comment tags', () => {
		const tag = '{#\ncomment line 1\ncomment line 2\n#}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		for (let i = 0; i < result.length; i++) {
			expect(result[i] === ' ' || result[i] === '\n').toBe(true);
		}
	});

	it('preserves newlines inside expression tags', () => {
		const tag = '{{\n  my_macro(\n    col\n  )\n}}';
		const result = b(tag);
		expect(result).toHaveLength(tag.length);
		const rawNl = [...tag].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		const resNl = [...result].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		expect(resNl).toEqual(rawNl);
	});

	// ── Multi-tag SQL strings ──────────────────────────────────────────────

	it('handles multiple ref tags in a single SQL string', () => {
		const sql = 'select * from {{ ref(\'orders\') }} o join {{ ref(\'customers\') }} c on o.customer_id = c.id';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		expect(result.includes('orders')).toBe(true);
		expect(result.includes('customers')).toBe(true);
		expect(result.includes('{{')).toBe(false);
	});

	it('handles a mix of block tags and expression tags', () => {
		const sql = '{% set x = \'foo\' %} select {{ ref(\'orders\') }}';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		expect(result.startsWith(' ')).toBe(true);
		expect(result.includes('orders')).toBe(true);
		expect(result.includes('{{')).toBe(false);
		expect(result.includes('{%')).toBe(false);
	});

	it('replaces all ref tags independently without interfering', () => {
		const ref1 = '{{ ref(\'aaa\') }}';
		const ref2 = '{{ ref(\'bbb\') }}';
		const sql = ref1 + ' join ' + ref2;
		const result = b(sql);
		expect(result.slice(0, ref1.length)).toBe(padTo('aaa', ref1.length));
		expect(result.slice(ref1.length + ' join '.length)).toBe(padTo('bbb', ref2.length));
	});

	// ── No-op cases ───────────────────────────────────────────────────────

	it('returns plain SQL unchanged', () => {
		const sql = 'select order_id, amount from raw_orders where status = \'shipped\'';
		expect(b(sql)).toBe(sql);
	});

	it('returns an empty string unchanged', () => {
		expect(b('')).toBe('');
	});

	// ── Nested {{ }} tags ─────────────────────────────────────────────────

	it('blanks config tag that contains {{ this }} in post_hook string', () => {
		const sql = '{{ config(post_hook="COPY {{ this }} TO \'output.parquet\'") }}';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		expect(result.trim()).toBe('');
		expect(result.includes('{{')).toBe(false);
	});

	it('blanks multiline config with nested {{ }} in post_hook', () => {
		const sql = [
			'{{',
			'    config(',
			'        materialized="table",',
			'        post_hook="COPY {{ this }} TO \'../data/output.parquet\'",',
			'    )',
			'}}',
		].join('\n');
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		for (let i = 0; i < result.length; i++) {
			if (sql[i] === '\n') expect(result[i]).toBe('\n');
			else expect(result[i]).toBe(' ');
		}
	});

	it('correctly blanks adjacent tags when nested {{ }} appears in the first', () => {
		const prefix = '{{ config(post_hook="{{ this }}") }}';
		const suffix = ' {{ ref(\'orders\') }}';
		const sql = prefix + suffix;
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		expect(result.slice(0, prefix.length).trim()).toBe('');
		expect(result.slice(prefix.length + 1)).toBe(padTo('orders', suffix.length - 1));
	});

	it('handles multiple levels of {{ }} nesting — outer gets a unique ID', () => {
		const sql = '{{ outer(inner="{{ a() }} text {{ b() }}") }}';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		expect(result.startsWith(makeJinjaId(0))).toBe(true);
		expect(result.includes('{{')).toBe(false);
	});

	// ── SQL characters that look like Jinja delimiters ────────────────────

	it('ignores single { and } characters in plain SQL', () => {
		const sql = 'select {\'key\': 1} as s, {{ ref(\'orders\') }} as o';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		expect(result.includes('{\'key\': 1}')).toBe(true);
		expect(result.includes('orders')).toBe(true);
	});

	it('ignores { } in SQL outside any Jinja tag', () => {
		const sql = 'select {col: val} from {{ ref(\'t\') }}';
		const result = b(sql);
		expect(result.startsWith('select {col: val} from ')).toBe(true);
	});

	it('handles {{ }} inside a Jinja tag string arg alongside outer SQL braces', () => {
		const sql = '{{ config(post_hook="{{ this }}") }} select {x: 1}';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
		const configEnd = '{{ config(post_hook="{{ this }}") }}'.length;
		expect(result.slice(0, configEnd).trim()).toBe('');
		expect(result.slice(configEnd)).toBe(' select {x: 1}');
	});

	// ── Known limitation ──────────────────────────────────────────────────

	it('documents: literal }} inside a string arg stops the depth counter early', () => {
		const sql = '{{ config(x="has }} in string") }}';
		const result = b(sql);
		expect(result).toHaveLength(sql.length);
	});
});

// ── makeJinjaId ───────────────────────────────────────────────────────────────

describe('makeJinjaId', () => {
	it('produces __j0__ for n=0', () => {
		expect(makeJinjaId(0)).toBe('__j0__');
	});

	it('produces __jZ__ for n=61 (last single base-62 digit)', () => {
		expect(makeJinjaId(61)).toBe('__jZ__');
	});

	it('produces __j10__ for n=62 (first two-digit base-62 number)', () => {
		expect(makeJinjaId(62)).toBe('__j10__');
	});

	it('IDs are always valid SQL identifiers (start with _, contain only alnum + _)', () => {
		for (const n of [0, 1, 61, 62, 3843, 3844]) {
			const id = makeJinjaId(n);
			expect(id).toMatch(/^__j[0-9a-zA-Z]+__$/);
		}
	});

	it('each successive ID is unique', () => {
		const ids = new Set(Array.from({ length: 100 }, (_, i) => makeJinjaId(i)));
		expect(ids.size).toBe(100);
	});
});

// ── comment mode ──────────────────────────────────────────────────────────────

describe('blankJinja comment mode', () => {
	it('replaces unknown macro with /* ... */ block comment', () => {
		const tag = '{{ my_macro(arg) }}';
		const result = b(tag, 'comment');
		expect(result).toHaveLength(tag.length);
		expect(result.startsWith('/*')).toBe(true);
		expect(result.endsWith('*/')).toBe(true);
	});

	it('length is preserved in comment mode', () => {
		const tag = '{{ generic_is_deleted(col) }}';
		expect(b(tag, 'comment')).toHaveLength(tag.length);
	});

	it('interior is spaces in comment mode', () => {
		const tag = '{{ my_macro(arg) }}';
		const result = b(tag, 'comment');
		expect(result.slice(2, result.length - 2).trim()).toBe('');
	});

	it('ref() tag is unchanged in comment mode (still uses real name)', () => {
		expect(b('{{ ref(\'orders\') }}', 'comment').startsWith('orders')).toBe(true);
	});

	it('source() tag is unchanged in comment mode (still uses real name)', () => {
		expect(b('{{ source(\'raw\', \'orders\') }}', 'comment').startsWith('orders')).toBe(true);
	});

	it('config() tag blanks to spaces in comment mode (STATEMENT_MACRO unchanged)', () => {
		const tag = '{{ config(materialized=\'table\') }}';
		expect(b(tag, 'comment')).toBe(' '.repeat(tag.length));
	});

	it('var() becomes /* */ in comment mode (no longer a special case)', () => {
		const tag = '{{ var("x") }}';
		const result = b(tag, 'comment');
		expect(result.startsWith('/*')).toBe(true);
		expect(result.endsWith('*/')).toBe(true);
	});

	it('block tags still blank to spaces in comment mode', () => {
		const tag = '{% if is_incremental() %}';
		expect(b(tag, 'comment')).toBe(' '.repeat(tag.length));
	});

	it('preserves newlines inside a comment-mode tag', () => {
		const tag = '{{\n  my_macro(\n    col\n  )\n}}';
		const result = b(tag, 'comment');
		expect(result).toHaveLength(tag.length);
		const rawNl = [...tag].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		const resNl = [...result].map((c, i) => (c === '\n' ? i : -1)).filter(i => i >= 0);
		expect(resNl).toEqual(rawNl);
	});

	it('falls back to spaces when tag has fewer than 4 non-newline chars', () => {
		const tag = '{{ m() }}';
		const result = b(tag, 'comment');
		expect(result.startsWith('/*')).toBe(true);
		expect(result.endsWith('*/')).toBe(true);
	});

	it('statement-level macro becomes /* */ in comment mode, making SQL parseable', () => {
		const sql = 'select id from t\n{{ generic_is_deleted(id, \'where\') }}';
		const result = b(sql, 'comment');
		expect(result).toHaveLength(sql.length);
		const macroStart = 'select id from t\n'.length;
		expect(result.slice(macroStart, macroStart + 2)).toBe('/*');
		expect(result.slice(-2)).toBe('*/');
	});

	it('comment mode idMap is empty (no IDs assigned when using /* */)', () => {
		const { idMap } = blankJinja('{{ my_macro() }}', 'comment');
		expect(idMap.size).toBe(0);
	});
});
