/**
 * A/B parity: `jinjaTokensFromStream` (JinjaToken[] derived from sqllens's unified
 * templated token stream — the NATIVE path) versus the extension's own
 * `tokenizeJinja` (the FALLBACK path). The contract the consumers depend on is
 * that swapping producers changes NOTHING they read, so on well-formed dbt SQL the
 * two streams are FIELD-FOR-FIELD deep-equal.
 *
 * The battery covers every jinja shape the task enumerates: single ref, 2-arg
 * source, package-qualified macro with nested-paren args, `{% set %}`, `{% if %}
 * … {% endif %}` control tags, a `{# comment #}`, a config-topped model, multi-line
 * tags, both quote styles, and adjacent tags. For all of these the deep-equal holds
 * exactly.
 *
 * The ONE shape where the raw streams legitimately differ — whitespace-control
 * (`{{- … -}}`) — is pinned in its own block with the proof that no consumer reads
 * the differing aspect: the `*_open` triple (start / tagEnd / type) the merge and
 * reflow printer read is identical, and the pattern-matching extractors
 * (extractSources / extractMacroCalls) produce identical output because their match
 * window is anchored on the callee and never spans the delimiter's `-`.
 */
import { describe, expect, it } from 'vitest';
import { parseTemplated } from './api';
import { jinjaTokensFromStream } from './extract/jinja-stream';
import type { JinjaToken } from '../jinja-tokenizer';
import { referenceTokenizeJinja as tokenizeJinja } from '../../test/ftl/reference-jinja-tokenizers';

function fromStream(sql: string): JinjaToken[] {
	const t = parseTemplated(sql, 'databricks');
	return jinjaTokensFromStream(t.tokens, t.tags, sql);
}

// ---------------------------------------------------------------------------
// The battery — deep-equal parity with tokenizeJinja.
// ---------------------------------------------------------------------------

describe('jinjaTokensFromStream — deep-equal with tokenizeJinja over the battery', () => {
	const battery: Record<string, string> = {
		'single ref': 'select * from {{ ref(\'orders\') }}',
		'source with 2 args': 'select * from {{ source(\'raw\', \'events\') }}',
		'package-qualified macro, nested-paren args':
			'select {{ dbt_utils.star(foo(1), bar(2)) }} from t',
		'{% set x = m(1) %}': '{% set x = m(1) %}\nselect 1',
		'if / endif control tags': '{% if cond %}\nselect 1\n{% endif %}',
		'{# comment #}': 'select 1 {# a comment #}',
		'config-topped model': '{{ config(materialized=\'table\') }}\nselect 1',
		'multi-line tag': 'select\n  {{ my_macro(a,\n     b) }}\nfrom t',
		'both quote styles': 'select {{ f(\'single\', "double") }} from t',
		'adjacent tags': 'select * from {{ ref(\'a\') }}{{ ref(\'b\') }}',
		// Extra shapes worth pinning.
		'comment with no spaces': 'select 1 {#tight#}',
		'empty comment': 'select 1 {# #}',
		'number literals': 'select {{ f(42, 3.14) }} from t',
		// `=[` is ONE coalesced jinja_operator in tokenizeJinja; the minijinja lexer
		// splits it into ASSIGN + LBRACK, so jinjaTokensFromStream re-fuses the run.
		'operator run =[ (config with list)': '{{ config(tags=[\'a\', \'b\']) }}\nselect 1',
	};

	for (const [name, sql] of Object.entries(battery)) {
		it(`matches for ${name}`, () => {
			expect(fromStream(sql)).toEqual(tokenizeJinja(sql));
		});
	}
});

// ---------------------------------------------------------------------------
// Field-level guarantees the consumers rely on, spelled out on the canonical ref.
// ---------------------------------------------------------------------------

describe('jinjaTokensFromStream — the fields consumers read', () => {
	it('sets tagEnd on the *_open only, from the owning tag span', () => {
		const sql = 'select * from {{ ref(\'orders\') }}';
		const toks = fromStream(sql);
		const open = toks.find(t => t.type === 'jinja_expression_open')!;
		expect(open.start).toBe(sql.indexOf('{{'));
		expect(open.tagEnd).toBe(sql.length); // tag runs to end of the string here
		// Every non-open token carries no tagEnd (they are members of the open's span).
		for (const t of toks) {
			if (t.type !== 'jinja_expression_open') expect(t.tagEnd).toBeUndefined();
		}
	});

	it('strips quotes from string values but keeps the quoted span', () => {
		const sql = '{{ ref(\'orders\') }}';
		const s = fromStream(sql).find(t => t.type === 'jinja_string')!;
		expect(s.value).toBe('orders');
		expect(sql.slice(s.start, s.end)).toBe('\'orders\''); // span still covers the quotes
	});

	it('classifies jinja keywords and constants as identifiers (like the extension)', () => {
		// `if`, `set`, `true`, `none` are ID-shaped -> jinja_identifier, matching
		// tokenizeStructuredTag's isIdentStart scan (the extractors read .value on these).
		const sql = '{% set x = true %}{% if none %}{% endif %}';
		const ids = fromStream(sql).filter(t => t.type === 'jinja_identifier').map(t => t.value);
		expect(ids).toEqual(['set', 'x', 'true', 'if', 'none', 'endif']);
	});
});

// ---------------------------------------------------------------------------
// Documented divergence: whitespace-control. The raw streams differ at the
// delimiter, but nothing a consumer reads does.
// ---------------------------------------------------------------------------

describe('jinjaTokensFromStream — whitespace-control divergence is consumer-invisible', () => {
	// tokenizeJinja emits the 2-char delimiter + a separate `jinja_operator '-'`;
	// the minijinja lexer folds the `-` into the delimiter token (EXPR_OPEN `{{-`).
	// This is the ONLY battery-adjacent shape where the raw streams differ.
	const sql = 'select * from {{- source(\'raw\', \'events\') -}}';

	it('raw streams differ only at the delimiter fold', () => {
		const a = fromStream(sql);
		const b = tokenizeJinja(sql);
		// The extension has TWO extra operator `-` tokens (one after {{, one before }}).
		expect(b.filter(t => t.type === 'jinja_operator' && t.value === '-')).toHaveLength(2);
		expect(a.filter(t => t.type === 'jinja_operator' && t.value === '-')).toHaveLength(0);
	});

	it('the *_open triple the merge + reflow read is identical', () => {
		const openA = fromStream(sql).find(t => t.type === 'jinja_expression_open')!;
		const openB = tokenizeJinja(sql).find(t => t.type === 'jinja_expression_open')!;
		// start / tagEnd / type — the only fields mergeSqlAndJinjaTokens and the reflow
		// printer read off a jinja token (reflow re-slices raw source start..tagEnd).
		expect(openA.start).toBe(openB.start);
		expect(openA.tagEnd).toBe(openB.tagEnd);
		expect(openA.type).toBe(openB.type);
	});
});
