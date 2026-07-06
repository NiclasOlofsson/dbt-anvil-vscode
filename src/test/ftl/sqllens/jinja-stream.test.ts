/**
 * Direct expectations for `jinjaTokensFromStream` (JinjaToken[] derived from sqllens's
 * unified templated token stream — the sole live producer of the extension's fine
 * jinja-token shape). The extension's own hand-written scanner that used to feed this
 * shape is retired; there is no longer a second implementation to diff against, so
 * every case here pins an EXPLICIT expected token array, derived from the input string
 * itself (via `indexOf`/`slice`/`.length` on the literal SQL, never by running the
 * tokenizer or any oracle) against the contract `src/ftl/jinja-tokenizer.ts` documents.
 *
 * The battery covers every jinja shape the contract cares about: single ref, 2-arg
 * source, package-qualified macro with nested-paren args, `{% set %}`, `{% if %}
 * … {% endif %}` control tags, a `{# comment #}` (padded / tight / empty), a
 * config-topped model, a tag spanning multiple lines, both quote styles, adjacent
 * tags with no gap, number literals (int + float), a coalesced operator run (`=[`),
 * and whitespace-control (`{{- … -}}`) delimiter folding.
 *
 * Consumers (src/dbt/debug-symbols.ts) pattern-match FIXED, ADJACENT fine-token
 * sequences (identifier, paren, string, ...), so every case here also proves: no
 * whitespace tokens ever; operator runs coalesce when adjacent; string values exclude
 * quotes but start/end still cover the quoted span; comment bodies are
 * whitespace-trimmed and an all-whitespace body emits nothing; every `*_open` token
 * carries `tagEnd` (the exclusive end of the whole tag).
 */
import { describe, expect, it } from 'vitest';
import { parseTemplated } from '../../../ftl/sqllens/api';
import { jinjaTokensFromStream } from '../../../ftl/sqllens/extract/jinja-stream';
import type { JinjaToken, JinjaTokenType } from '../../../ftl/jinja-tokenizer';

function fromStream(sql: string): JinjaToken[] {
	const t = parseTemplated(sql, 'databricks');
	return jinjaTokensFromStream(t.tokens, t.tags, sql);
}

/** 0-based line/col for `offset`, counted directly off `sql` (independent of the
 *  production line-index helper — this is the test's own ground truth). */
function lc(sql: string, offset: number): { line: number; col: number } {
	let line = 0;
	let lastNl = -1;
	for (let i = 0; i < offset; i++) {
		if (sql[i] === '\n') { line++; lastNl = i; }
	}
	return { line, col: offset - lastNl - 1 };
}

/** Build one expected JinjaToken, deriving line/col from `start` via `lc`. */
function tok(sql: string, type: JinjaTokenType, start: number, end: number, value: string, tagEnd?: number): JinjaToken {
	const { line, col } = lc(sql, start);
	return tagEnd === undefined ? { type, start, end, line, col, value } : { type, start, end, line, col, value, tagEnd };
}

// ---------------------------------------------------------------------------
// Direct expectations, one shape at a time.
// ---------------------------------------------------------------------------

describe('jinjaTokensFromStream — direct token-shape expectations', () => {
	it('ref() call: identifier, paren, string (quotes stripped, span kept), tagEnd to end of tag (was: "single ref")', () => {
		const sql = 'select * from {{ ref(\'orders\') }}';
		const openStart = sql.indexOf('{{');
		const idStart = sql.indexOf('ref');
		const lpStart = idStart + 'ref'.length;
		const strOpen = lpStart + 1;
		const strClose = sql.indexOf('\'', strOpen + 1);
		const rpStart = strClose + 1;
		const closeStart = sql.indexOf('}}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 3, 'ref'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_string', strOpen, strClose + 1, 'orders'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('source() with two args: comma-separated strings (was: "source with 2 args")', () => {
		const sql = 'select * from {{ source(\'raw\', \'events\') }}';
		const openStart = sql.indexOf('{{');
		const idStart = sql.indexOf('source');
		const lpStart = idStart + 'source'.length;
		const str1Open = lpStart + 1;
		const str1Close = sql.indexOf('\'', str1Open + 1);
		const commaStart = str1Close + 1;
		const str2Open = sql.indexOf('\'', commaStart);
		const str2Close = sql.indexOf('\'', str2Open + 1);
		const rpStart = str2Close + 1;
		const closeStart = sql.indexOf('}}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 6, 'source'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_string', str1Open, str1Close + 1, 'raw'),
			tok(sql, 'jinja_comma', commaStart, commaStart + 1, ','),
			tok(sql, 'jinja_string', str2Open, str2Close + 1, 'events'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('package-qualified macro with nested-paren args: dot, nested calls, numbers (was: "package-qualified macro, nested-paren args")', () => {
		const sql = 'select {{ dbt_utils.star(foo(1), bar(2)) }} from t';
		const id1Start = sql.indexOf('dbt_utils');
		const dotStart = id1Start + 'dbt_utils'.length;
		const id2Start = dotStart + 1;
		const lp1Start = id2Start + 'star'.length;
		const id3Start = lp1Start + 1;
		const lp2Start = id3Start + 'foo'.length;
		const num1Start = lp2Start + 1;
		const rp1Start = num1Start + '1'.length;
		const commaStart = rp1Start + 1;
		const id4Start = sql.indexOf('bar', commaStart);
		const lp3Start = id4Start + 'bar'.length;
		const num2Start = lp3Start + 1;
		const rp2Start = num2Start + '2'.length;
		const rp3Start = rp2Start + 1;
		const openStart = sql.indexOf('{{');
		const closeStart = sql.indexOf('}}', rp3Start);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', id1Start, id1Start + 'dbt_utils'.length, 'dbt_utils'),
			tok(sql, 'jinja_dot', dotStart, dotStart + 1, '.'),
			tok(sql, 'jinja_identifier', id2Start, id2Start + 'star'.length, 'star'),
			tok(sql, 'jinja_paren_open', lp1Start, lp1Start + 1, '('),
			tok(sql, 'jinja_identifier', id3Start, id3Start + 'foo'.length, 'foo'),
			tok(sql, 'jinja_paren_open', lp2Start, lp2Start + 1, '('),
			tok(sql, 'jinja_number', num1Start, num1Start + 1, '1'),
			tok(sql, 'jinja_paren_close', rp1Start, rp1Start + 1, ')'),
			tok(sql, 'jinja_comma', commaStart, commaStart + 1, ','),
			tok(sql, 'jinja_identifier', id4Start, id4Start + 'bar'.length, 'bar'),
			tok(sql, 'jinja_paren_open', lp3Start, lp3Start + 1, '('),
			tok(sql, 'jinja_number', num2Start, num2Start + 1, '2'),
			tok(sql, 'jinja_paren_close', rp2Start, rp2Start + 1, ')'),
			tok(sql, 'jinja_paren_close', rp3Start, rp3Start + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('number literals: int and float share the digit/dot scan (was: "number literals")', () => {
		const sql = 'select {{ f(42, 3.14) }} from t';
		const openStart = sql.indexOf('{{');
		const idStart = sql.indexOf('f(');
		const lpStart = idStart + 1;
		const num1Start = lpStart + 1;
		const num1End = num1Start + '42'.length;
		const commaStart = num1End;
		const num2Start = sql.indexOf('3', commaStart);
		const num2End = num2Start + '3.14'.length;
		const rpStart = num2End;
		const closeStart = sql.indexOf('}}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 1, 'f'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_number', num1Start, num1End, '42'),
			tok(sql, 'jinja_comma', commaStart, commaStart + 1, ','),
			tok(sql, 'jinja_number', num2Start, num2End, '3.14'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('{% set x = m(1) %}: block tag, single-char operator, nested call (was: "{% set x = m(1) %}")', () => {
		const sql = '{% set x = m(1) %}\nselect 1';
		const openStart = sql.indexOf('{%');
		const id1Start = sql.indexOf('set');
		const id2Start = sql.indexOf('x', id1Start);
		const opStart = sql.indexOf('=', id2Start);
		const id3Start = sql.indexOf('m', opStart);
		const lpStart = id3Start + 1;
		const numStart = lpStart + 1;
		const rpStart = numStart + '1'.length;
		const closeStart = sql.indexOf('%}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_block_open', openStart, openStart + 2, '{%', tagEnd),
			tok(sql, 'jinja_identifier', id1Start, id1Start + 3, 'set'),
			tok(sql, 'jinja_identifier', id2Start, id2Start + 1, 'x'),
			tok(sql, 'jinja_operator', opStart, opStart + 1, '='),
			tok(sql, 'jinja_identifier', id3Start, id3Start + 1, 'm'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_number', numStart, numStart + 1, '1'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_block_close', closeStart, closeStart + 2, '%}'),
		]);
	});

	it('{% config %}-shaped expression tag: identifier, single-char operator, string (was: "config-topped model")', () => {
		const sql = '{{ config(materialized=\'table\') }}\nselect 1';
		const openStart = sql.indexOf('{{');
		const idStart = sql.indexOf('config');
		const lpStart = idStart + 'config'.length;
		const id2Start = lpStart + 1;
		const opStart = id2Start + 'materialized'.length;
		const strOpen = opStart + 1;
		const strClose = sql.indexOf('\'', strOpen + 1);
		const rpStart = strClose + 1;
		const closeStart = sql.indexOf('}}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 'config'.length, 'config'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_identifier', id2Start, id2Start + 'materialized'.length, 'materialized'),
			tok(sql, 'jinja_operator', opStart, opStart + 1, '='),
			tok(sql, 'jinja_string', strOpen, strClose + 1, 'table'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('if / endif control tags: two block tags, line/col track across the newline between them (was: "if / endif control tags")', () => {
		const sql = '{% if cond %}\nselect 1\n{% endif %}';
		const open1 = sql.indexOf('{%');
		const id1Start = sql.indexOf('if');
		const id2Start = sql.indexOf('cond');
		const close1 = sql.indexOf('%}', id2Start);
		const tagEnd1 = close1 + 2;
		const open2 = sql.indexOf('{%', tagEnd1);
		const id3Start = sql.indexOf('endif', open2);
		const close2 = sql.indexOf('%}', id3Start);
		const tagEnd2 = close2 + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_block_open', open1, open1 + 2, '{%', tagEnd1),
			tok(sql, 'jinja_identifier', id1Start, id1Start + 2, 'if'),
			tok(sql, 'jinja_identifier', id2Start, id2Start + 4, 'cond'),
			tok(sql, 'jinja_block_close', close1, close1 + 2, '%}'),
			tok(sql, 'jinja_block_open', open2, open2 + 2, '{%', tagEnd2),
			tok(sql, 'jinja_identifier', id3Start, id3Start + 5, 'endif'),
			tok(sql, 'jinja_block_close', close2, close2 + 2, '%}'),
		]);
	});

	it('{# a comment #}: body whitespace-trimmed, span shrinks to the trimmed text (was: "{# comment #}")', () => {
		const sql = 'select 1 {# a comment #}';
		const openStart = sql.indexOf('{#');
		const contentStart = sql.indexOf('a comment');
		const contentEnd = contentStart + 'a comment'.length;
		const closeStart = sql.indexOf('#}', contentEnd);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_comment_open', openStart, openStart + 2, '{#', tagEnd),
			tok(sql, 'jinja_text', contentStart, contentEnd, 'a comment'),
			tok(sql, 'jinja_comment_close', closeStart, closeStart + 2, '#}'),
		]);
	});

	it('{#tight#}: no padding, so no trimming needed (was: "comment with no spaces")', () => {
		const sql = 'select 1 {#tight#}';
		const openStart = sql.indexOf('{#');
		const contentStart = openStart + 2;
		const contentEnd = sql.indexOf('#}', contentStart);
		const tagEnd = contentEnd + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_comment_open', openStart, openStart + 2, '{#', tagEnd),
			tok(sql, 'jinja_text', contentStart, contentEnd, 'tight'),
			tok(sql, 'jinja_comment_close', contentEnd, contentEnd + 2, '#}'),
		]);
	});

	it('{# #}: all-whitespace body emits NO jinja_text token (was: "empty comment")', () => {
		const sql = 'select 1 {# #}';
		const openStart = sql.indexOf('{#');
		const closeStart = sql.indexOf('#}', openStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_comment_open', openStart, openStart + 2, '{#', tagEnd),
			tok(sql, 'jinja_comment_close', closeStart, closeStart + 2, '#}'),
		]);
	});

	it('a tag spanning multiple lines: position tracks through it, whitespace (incl. the newline) never emitted (was: "multi-line tag")', () => {
		const sql = 'select\n  {{ my_macro(a,\n     b) }}\nfrom t';
		const openStart = sql.indexOf('{{');
		const idStart = sql.indexOf('my_macro');
		const lpStart = idStart + 'my_macro'.length;
		const idAStart = lpStart + 1;
		const commaStart = idAStart + 1;
		const idBStart = sql.indexOf('b', commaStart + 1);
		const rpStart = idBStart + 1;
		const closeStart = sql.indexOf('}}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 'my_macro'.length, 'my_macro'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_identifier', idAStart, idAStart + 1, 'a'),
			tok(sql, 'jinja_comma', commaStart, commaStart + 1, ','),
			tok(sql, 'jinja_identifier', idBStart, idBStart + 1, 'b'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('both quote styles: single- and double-quoted strings both strip quotes (was: "both quote styles")', () => {
		const sql = 'select {{ f(\'single\', "double") }} from t';
		const openStart = sql.indexOf('{{');
		const idStart = sql.indexOf('f(');
		const lpStart = idStart + 1;
		const str1Open = lpStart + 1;
		const str1Close = sql.indexOf('\'', str1Open + 1);
		const commaStart = str1Close + 1;
		const str2Open = sql.indexOf('"', commaStart);
		const str2Close = sql.indexOf('"', str2Open + 1);
		const rpStart = str2Close + 1;
		const closeStart = sql.indexOf('}}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 1, 'f'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_string', str1Open, str1Close + 1, 'single'),
			tok(sql, 'jinja_comma', commaStart, commaStart + 1, ','),
			tok(sql, 'jinja_string', str2Open, str2Close + 1, 'double'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('adjacent tags, no gap: each tag keeps its own tagEnd, none swallows the next (was: "adjacent tags")', () => {
		const sql = 'select * from {{ ref(\'a\') }}{{ ref(\'b\') }}';
		const open1 = sql.indexOf('{{');
		const id1Start = sql.indexOf('ref', open1);
		const lp1Start = id1Start + 'ref'.length;
		const str1Open = lp1Start + 1;
		const str1Close = sql.indexOf('\'', str1Open + 1);
		const rp1Start = str1Close + 1;
		const close1 = sql.indexOf('}}', rp1Start);
		const tagEnd1 = close1 + 2;

		const open2 = sql.indexOf('{{', tagEnd1);
		const id2Start = sql.indexOf('ref', open2);
		const lp2Start = id2Start + 'ref'.length;
		const str2Open = lp2Start + 1;
		const str2Close = sql.indexOf('\'', str2Open + 1);
		const rp2Start = str2Close + 1;
		const close2 = sql.indexOf('}}', rp2Start);
		const tagEnd2 = close2 + 2;

		// The second tag opens exactly where the first ends — no gap, and the
		// first tag's tagEnd must not have swallowed into the second tag.
		expect(open2).toBe(tagEnd1);

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', open1, open1 + 2, '{{', tagEnd1),
			tok(sql, 'jinja_identifier', id1Start, id1Start + 3, 'ref'),
			tok(sql, 'jinja_paren_open', lp1Start, lp1Start + 1, '('),
			tok(sql, 'jinja_string', str1Open, str1Close + 1, 'a'),
			tok(sql, 'jinja_paren_close', rp1Start, rp1Start + 1, ')'),
			tok(sql, 'jinja_expression_close', close1, close1 + 2, '}}'),
			tok(sql, 'jinja_expression_open', open2, open2 + 2, '{{', tagEnd2),
			tok(sql, 'jinja_identifier', id2Start, id2Start + 3, 'ref'),
			tok(sql, 'jinja_paren_open', lp2Start, lp2Start + 1, '('),
			tok(sql, 'jinja_string', str2Open, str2Close + 1, 'b'),
			tok(sql, 'jinja_paren_close', rp2Start, rp2Start + 1, ')'),
			tok(sql, 'jinja_expression_close', close2, close2 + 2, '}}'),
		]);
	});

	it('operator run =[ (config with list): adjacent operator-class chars fuse into one token (was: "operator run =[ (config with list)")', () => {
		// minijinja lexes `=` and `[` as separate tokens (ASSIGN, LBRACK); the
		// extension's contract reads a maximal adjacent run as ONE jinja_operator,
		// so jinjaTokensFromStream must re-fuse them.
		const sql = '{{ config(tags=[\'a\', \'b\']) }}\nselect 1';
		const openStart = sql.indexOf('{{');
		const idStart = sql.indexOf('config');
		const lpStart = idStart + 'config'.length;
		const id2Start = lpStart + 1;
		const opStart = id2Start + 'tags'.length;
		const fusedEnd = opStart + 2; // '=' + '[' fused into one token
		const str1Open = fusedEnd;
		const str1Close = sql.indexOf('\'', str1Open + 1);
		const commaStart = str1Close + 1;
		const str2Open = sql.indexOf('\'', commaStart);
		const str2Close = sql.indexOf('\'', str2Open + 1);
		const rbrackStart = str2Close + 1;
		const rpStart = rbrackStart + 1;
		const closeStart = sql.indexOf('}}', rpStart);
		const tagEnd = closeStart + 2;

		expect(fromStream(sql)).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openStart + 2, '{{', tagEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 'config'.length, 'config'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_identifier', id2Start, id2Start + 'tags'.length, 'tags'),
			tok(sql, 'jinja_operator', opStart, fusedEnd, '=['),
			tok(sql, 'jinja_string', str1Open, str1Close + 1, 'a'),
			tok(sql, 'jinja_comma', commaStart, commaStart + 1, ','),
			tok(sql, 'jinja_string', str2Open, str2Close + 1, 'b'),
			tok(sql, 'jinja_operator', rbrackStart, rbrackStart + 1, ']'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeStart + 2, '}}'),
		]);
	});

	it('whitespace-control ({{- … -}}): the dash folds into the open/close tokens, no separate operator token (was: whitespace-control divergence)', () => {
		// minijinja's EXPR_OPEN/EXPR_CLOSE grammar rules include the optional
		// whitespace-control `-` IN the delimiter token itself ('{{' '-'? / '-'?
		// '}}'), unlike the retired extension scanner which emitted the 2-char
		// delimiter plus a separate jinja_operator '-'. Nothing a consumer reads
		// (tagEnd / type / the absence of stray '-' operators) is affected.
		const sql = 'select * from {{- source(\'raw\', \'events\') -}}';
		const openStart = sql.indexOf('{{');
		const openEnd = openStart + 3; // '{{-'
		const idStart = sql.indexOf('source');
		const lpStart = idStart + 'source'.length;
		const str1Open = lpStart + 1;
		const str1Close = sql.indexOf('\'', str1Open + 1);
		const commaStart = str1Close + 1;
		const str2Open = sql.indexOf('\'', commaStart);
		const str2Close = sql.indexOf('\'', str2Open + 1);
		const rpStart = str2Close + 1;
		const closeStart = sql.indexOf('-}}', rpStart);
		const closeEnd = closeStart + 3; // '-}}'

		const toks = fromStream(sql);
		expect(toks.filter(t => t.type === 'jinja_operator' && t.value === '-')).toHaveLength(0);
		expect(toks).toEqual([
			tok(sql, 'jinja_expression_open', openStart, openEnd, '{{-', closeEnd),
			tok(sql, 'jinja_identifier', idStart, idStart + 'source'.length, 'source'),
			tok(sql, 'jinja_paren_open', lpStart, lpStart + 1, '('),
			tok(sql, 'jinja_string', str1Open, str1Close + 1, 'raw'),
			tok(sql, 'jinja_comma', commaStart, commaStart + 1, ','),
			tok(sql, 'jinja_string', str2Open, str2Close + 1, 'events'),
			tok(sql, 'jinja_paren_close', rpStart, rpStart + 1, ')'),
			tok(sql, 'jinja_expression_close', closeStart, closeEnd, '-}}'),
		]);
	});
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
