import { describe, expect, it } from 'vitest';
import { tokenize, getTagName } from '../dbt/jinja-tokenizer';
import type { JinjaToken } from '../dbt/jinja-tokenizer';

// Asserts the core invariant: every token's raw text matches the source slice.
function assertOffsets(source: string, tokens: JinjaToken[]) {
	for (const tok of tokens) {
		expect(source.slice(tok.start, tok.end)).toBe(tok.raw);
	}
}

describe('tokenize', () => {
	// ── Basic cases ────────────────────────────────────────────────────────

	it('returns empty array for empty string', () => {
		expect(tokenize('')).toEqual([]);
	});

	it('returns single text token for plain SQL', () => {
		const source = 'SELECT * FROM orders';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('text');
		expect(tokens[0].raw).toBe(source);
		expect(tokens[0].content).toBe(source);
	});

	it('returns no text token for a document that is only a tag', () => {
		const source = '{% if x %}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('tag');
	});

	// ── Expression tokens {{ }} ────────────────────────────────────────────

	it('tokenizes a simple expression', () => {
		const source = '{{ ref(\'orders\') }}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('expression');
		expect(tokens[0].raw).toBe(source);
		expect(tokens[0].content).toBe(' ref(\'orders\') ');
	});

	it('tokenizes whitespace-control expression {{- -}}', () => {
		const source = '{{- val -}}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('expression');
		expect(tokens[0].content).toBe('- val -');
	});

	// ── Tag tokens {% %} ──────────────────────────────────────────────────

	it('tokenizes a simple tag', () => {
		const source = '{% if is_incremental() %}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('tag');
		expect(tokens[0].raw).toBe(source);
		expect(tokens[0].content).toBe(' if is_incremental() ');
	});

	it('tokenizes whitespace-control tag {%- -%}', () => {
		const source = '{%- for item in list -%}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('tag');
		expect(tokens[0].content).toBe('- for item in list -');
	});

	// ── Comment tokens {# #} ──────────────────────────────────────────────

	it('tokenizes a comment', () => {
		const source = '{# this is a comment #}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('comment');
		expect(tokens[0].content).toBe(' this is a comment ');
	});

	it('tokenizes whitespace-control comment {#- -#}', () => {
		const source = '{#- trimmed comment -#}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('comment');
	});

	// ── Mixed documents ────────────────────────────────────────────────────

	it('tokenizes a mixed document in correct order', () => {
		const source = 'SELECT {{ col }} FROM {% if x %}orders{% else %}fallback{% endif %}';
		const tokens = tokenize(source);
		const types = tokens.map(t => t.type);
		expect(types).toEqual(['text', 'expression', 'text', 'tag', 'text', 'tag', 'text', 'tag']);
	});

	it('tokenizes a realistic incremental model snippet', () => {
		const source = [
			'{% if is_incremental() %}',
			'  WHERE updated_at > (SELECT MAX(updated_at) FROM {{ this }})',
			'{% endif %}',
		].join('\n');
		const tokens = tokenize(source);
		const types = tokens.map(t => t.type);
		expect(types).toContain('tag');
		expect(types).toContain('expression');
		assertOffsets(source, tokens);
	});

	it('preserves text between two expressions', () => {
		const source = '{{ a }} AND {{ b }}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(3);
		expect(tokens[0].type).toBe('expression');
		expect(tokens[1].type).toBe('text');
		expect(tokens[1].content).toBe(' AND ');
		expect(tokens[2].type).toBe('expression');
	});

	// ── Multiline ──────────────────────────────────────────────────────────

	it('handles a multiline tag correctly', () => {
		const source = '{%\n  if\n  is_incremental()\n%}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('tag');
		expect(tokens[0].raw).toBe(source);
	});

	it('handles a multiline expression correctly', () => {
		const source = '{{\n  ref(\n    "orders"\n  )\n}}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('expression');
	});

	// ── String literals containing closing delimiters ──────────────────────

	it('does not split expression on }} inside a string literal', () => {
		const source = '{{ \'}}\' }}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('expression');
	});

	it('does not split tag on %} inside a single-quoted string', () => {
		const source = '{% set x = \'hello %}\' %}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('tag');
	});

	it('does not split tag on %} inside a double-quoted string', () => {
		const source = '{% set x = "hello %}" %}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('tag');
	});

	it('handles backslash escape inside string literal', () => {
		const source = '{% set x = \'it\\\' s fine %}\' %}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('tag');
	});

	// ── Offset invariant ───────────────────────────────────────────────────

	it('satisfies offset invariant for plain SQL', () => {
		const source = 'SELECT 1';
		assertOffsets(source, tokenize(source));
	});

	it('satisfies offset invariant for expression', () => {
		const source = '{{ ref(\'orders\') }}';
		assertOffsets(source, tokenize(source));
	});

	it('satisfies offset invariant for mixed document', () => {
		const source = [
			'SELECT {{ col }}',
			'FROM {% if x %}orders{% else %}fallback{% endif %}',
		].join('\n');
		assertOffsets(source, tokenize(source));
	});

	it('satisfies offset invariant for multiline macro', () => {
		const source = [
			'{% macro my_macro(a, b="default") %}',
			'  SELECT {{ a }}, {{ b }}',
			'  FROM orders',
			'{% endmacro %}',
		].join('\n');
		assertOffsets(source, tokenize(source));
	});

	// ── Lone { chars ───────────────────────────────────────────────────────

	it('treats a lone { as plain text', () => {
		const source = 'x { y';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('text');
	});

	it('does not confuse {a} with a Jinja2 token', () => {
		const source = '{not_jinja}';
		const tokens = tokenize(source);
		expect(tokens).toHaveLength(1);
		expect(tokens[0].type).toBe('text');
	});
});

// ── getTagName ─────────────────────────────────────────────────────────────────

describe('getTagName', () => {
	const tag = (content: string) => tokenize(`{%${content}%}`)[0];

	it('returns the tag name for a simple if', () => {
		expect(getTagName(tag(' if x '))).toBe('if');
	});

	it('returns the tag name for elif', () => {
		expect(getTagName(tag(' elif y '))).toBe('elif');
	});

	it('returns the tag name for else', () => {
		expect(getTagName(tag(' else '))).toBe('else');
	});

	it('returns the tag name for endif', () => {
		expect(getTagName(tag(' endif '))).toBe('endif');
	});

	it('returns the tag name for for', () => {
		expect(getTagName(tag(' for item in list '))).toBe('for');
	});

	it('returns the tag name for endfor', () => {
		expect(getTagName(tag(' endfor '))).toBe('endfor');
	});

	it('returns the tag name for macro', () => {
		expect(getTagName(tag(' macro my_macro(a, b) '))).toBe('macro');
	});

	it('returns the tag name for endmacro', () => {
		expect(getTagName(tag(' endmacro '))).toBe('endmacro');
	});

	it('strips leading whitespace-control dash from {%- tag', () => {
		const token = tokenize('{%- if x -%}')[0];
		expect(getTagName(token)).toBe('if');
	});

	it('returns undefined for non-tag tokens', () => {
		const expr = tokenize('{{ x }}')[0];
		expect(getTagName(expr)).toBeUndefined();
	});

	it('returns undefined for expression token', () => {
		const expr = tokenize('{{ something }}')[0];
		expect(getTagName(expr)).toBeUndefined();
	});
});
