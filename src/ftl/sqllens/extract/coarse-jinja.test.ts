/**
 * Direct expectations for `coarseJinjaTokens` (the coarse per-tag stream grouped from
 * the fine jinja stream) — the ninja engine's token currency. The extension's own
 * hand-written coarse scanner (`src/dbt/jinja-tokenizer.ts`) that used to be diffed
 * against here is retired; there is no second implementation left to compare with, so
 * every battery case pins an EXPLICIT expected token array, derived from the input
 * string itself (via `indexOf`/`slice` on the literal SQL, never by running
 * `coarseJinjaTokens` or any oracle), and the corpus sweep checks ORACLE-FREE
 * invariants instead of equality with a retired reference.
 *
 * The consumers (layout rules, jinja-padding, the ambiguity rule's tag scan) rely on:
 *   - a tag OPENING inside a `--` line comment stays text, so rules never flag jinja
 *     on commented-out lines (including the old scanner's quirk that the skip never
 *     tracks string literals, and that a `--` inside a tag body never triggers it);
 *   - `content` strips exactly the 2-char delimiters, keeping whitespace-control
 *     dashes (`{{- x -}}` -> `- x -`) — unlike the FINE stream, comment bodies are
 *     NOT trimmed here;
 *   - adjacent tags produce no empty text token between them;
 *   - a delimiter look-alike inside a quoted string never ends the tag early.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTemplated } from '../api';
import { jinjaTokensFromStream } from './jinja-stream';
import { coarseJinjaTokens, coarseJinjaTokensFromText } from './coarse-jinja';
import type { JinjaToken, JinjaTokenType } from './coarse-jinja';

function viaSqllensStream(sql: string): JinjaToken[] {
	const t = parseTemplated(sql, 'databricks');
	return coarseJinjaTokens(jinjaTokensFromStream(t.tokens, t.tags, sql), sql);
}

/** Build one expected coarse JinjaToken; `content`/`raw` are sliced straight off
 *  `sql`, per the documented contract (raw = source.slice(start,end), content =
 *  raw with the outer 2 chars of each delimiter stripped). */
function tok(sql: string, type: JinjaTokenType, start: number, end: number): JinjaToken {
	const raw = sql.slice(start, end);
	const content = type === 'text' ? raw : raw.slice(2, -2);
	return { type, content, raw, start, end };
}

describe('coarseJinjaTokens — direct token-shape expectations', () => {
	it('plain text, no jinja: the whole source is one text token', () => {
		const sql = 'select 1 from t\nwhere x = 2';
		expect(viaSqllensStream(sql)).toEqual([tok(sql, 'text', 0, sql.length)]);
	});

	it('single ref, tag at end of source: leading text + one expression tag (was: "single ref" / "tag at end of source")', () => {
		const sql = 'select * from {{ ref(\'orders\') }}';
		const openStart = sql.indexOf('{{');
		const closeStart = sql.lastIndexOf('}}');
		const tagEnd = closeStart + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'text', 0, openStart),
			tok(sql, 'expression', openStart, tagEnd),
		]);
	});

	it('tag at start of source: no leading text token', () => {
		const sql = '{{ config(materialized=\'table\') }}\nselect 1';
		const openStart = sql.indexOf('{{');
		const closeStart = sql.indexOf('}}');
		const tagEnd = closeStart + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'expression', openStart, tagEnd),
			tok(sql, 'text', tagEnd, sql.length),
		]);
	});

	it('adjacent tags, no text between: no empty text token is emitted', () => {
		const sql = 'select * from {{ ref(\'a\') }}{{ ref(\'b\') }}';
		const open1 = sql.indexOf('{{');
		const close1 = sql.indexOf('}}', open1);
		const tagEnd1 = close1 + 2;
		const open2 = sql.indexOf('{{', tagEnd1);
		const close2 = sql.indexOf('}}', open2);
		const tagEnd2 = close2 + 2;

		expect(open2).toBe(tagEnd1); // no gap in the source between the two tags

		const toks = viaSqllensStream(sql);
		expect(toks).toEqual([
			tok(sql, 'text', 0, open1),
			tok(sql, 'expression', open1, tagEnd1),
			tok(sql, 'expression', open2, tagEnd2),
		]);
		expect(toks.some(t => t.type === 'text' && t.content === '')).toBe(false);
	});

	it('block tag then text then expression tag', () => {
		const sql = '{% set x = 1 %}\nselect {{ x }}';
		const open1 = sql.indexOf('{%');
		const close1 = sql.indexOf('%}', open1);
		const tagEnd1 = close1 + 2;
		const open2 = sql.indexOf('{{', tagEnd1);
		const close2 = sql.indexOf('}}', open2);
		const tagEnd2 = close2 + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'tag', open1, tagEnd1),
			tok(sql, 'text', tagEnd1, open2),
			tok(sql, 'expression', open2, tagEnd2),
		]);
	});

	it('comment tag: content keeps its internal padding (coarse does NOT trim, unlike the fine stream)', () => {
		const sql = 'select 1 {# a comment #}';
		const openStart = sql.indexOf('{#');
		const closeStart = sql.indexOf('#}', openStart);
		const tagEnd = closeStart + 2;

		const toks = viaSqllensStream(sql);
		expect(toks).toEqual([
			tok(sql, 'text', 0, openStart),
			tok(sql, 'comment', openStart, tagEnd),
		]);
		expect(toks.find(t => t.type === 'comment')!.content).toBe(' a comment '); // padding kept
	});

	it('whitespace-control dashes kept in content ({{- x -}} -> content starts/ends with "-")', () => {
		const sql = '{{- ref(\'a\') -}}\n{%- if x -%}\nselect 1\n{%- endif -%}';
		const open1 = sql.indexOf('{{');
		const close1 = sql.indexOf('}}', open1);
		const tagEnd1 = close1 + 2;
		const open2 = sql.indexOf('{%', tagEnd1);
		const close2 = sql.indexOf('%}', open2);
		const tagEnd2 = close2 + 2;
		const open3 = sql.indexOf('{%', tagEnd2);
		const close3 = sql.indexOf('%}', open3);
		const tagEnd3 = close3 + 2;

		const toks = viaSqllensStream(sql);
		expect(toks).toEqual([
			tok(sql, 'expression', open1, tagEnd1),
			tok(sql, 'text', tagEnd1, open2),
			tok(sql, 'tag', open2, tagEnd2),
			tok(sql, 'text', tagEnd2, open3),
			tok(sql, 'tag', open3, tagEnd3),
		]);
		expect(toks[0].content).toBe('- ref(\'a\') -');
		expect(toks[2].content).toBe('- if x -');
		expect(toks[4].content).toBe('- endif -');
	});

	it('a tag spanning multiple lines is one whole coarse token', () => {
		const sql = 'select\n  {{ my_macro(a,\n     b) }}\nfrom t';
		const openStart = sql.indexOf('{{');
		const closeStart = sql.indexOf('}}', openStart);
		const tagEnd = closeStart + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'text', 0, openStart),
			tok(sql, 'expression', openStart, tagEnd),
			tok(sql, 'text', tagEnd, sql.length),
		]);
	});

	it('quoted close delimiters inside a tag do not end the tag early', () => {
		const sql = '{{ config(post_hook="insert {{ this }}") }}\nselect 1';
		const openStart = sql.indexOf('{{');
		// Two "}}" occur in the source: one inside the string literal, one for the
		// real tag close. The real close is the LAST one (the string's fake close
		// comes first).
		const closeStart = sql.lastIndexOf('}}');
		const tagEnd = closeStart + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'expression', openStart, tagEnd),
			tok(sql, 'text', tagEnd, sql.length),
		]);
	});

	it('jinja after -- is text (line-comment skip) (was: "jinja after -- is text")', () => {
		const sql = 'select 1 -- {{ ref(\'a\') }}\nfrom {{ ref(\'b\') }}';
		const nlPos = sql.indexOf('\n');
		const open2 = sql.indexOf('{{', nlPos);
		const close2 = sql.indexOf('}}', open2);
		const tagEnd2 = close2 + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'text', 0, open2), // swallows the whole first line, incl. the fake tag
			tok(sql, 'expression', open2, tagEnd2),
		]);
	});

	it('-- inside a string still skips: text mode never tracks quotes (old-scanner quirk)', () => {
		const sql = 'select \'a--b\' {{ ref(\'x\') }}\nfrom {{ ref(\'y\') }}';
		const dashPos = sql.indexOf('--');
		const nlPos = sql.indexOf('\n', dashPos);
		const open2 = sql.indexOf('{{', nlPos);
		const close2 = sql.indexOf('}}', open2);
		const tagEnd2 = close2 + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'text', 0, open2), // the first {{ ref('x') }} is swallowed too
			tok(sql, 'expression', open2, tagEnd2),
		]);
	});

	it('-- inside a tag body does not skip: the tag is still recognized', () => {
		const sql = 'select {{ f(\'--\') }} from t';
		const openStart = sql.indexOf('{{');
		const closeStart = sql.indexOf('}}', openStart);
		const tagEnd = closeStart + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'text', 0, openStart),
			tok(sql, 'expression', openStart, tagEnd),
			tok(sql, 'text', tagEnd, sql.length),
		]);
	});

	it('-- at end of line, tag on next line: the skip does not reach past the newline', () => {
		const sql = 'select 1 --\nfrom {{ ref(\'a\') }}';
		const dashPos = sql.indexOf('--');
		const nlPos = sql.indexOf('\n', dashPos);
		const open1 = sql.indexOf('{{', nlPos);
		const close1 = sql.indexOf('}}', open1);
		const tagEnd1 = close1 + 2;

		expect(viaSqllensStream(sql)).toEqual([
			tok(sql, 'text', 0, open1),
			tok(sql, 'expression', open1, tagEnd1),
		]);
	});

	it('coarseJinjaTokensFromText equals the sqllens-stream route', () => {
		const sql = 'select * from {{ ref(\'orders\') }}';
		expect(coarseJinjaTokensFromText(sql)).toEqual(viaSqllensStream(sql));
	});
});

// ---------------------------------------------------------------------------
// Corpus sweep — every sample model, checked against oracle-free invariants.
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, '..', '..', '..', '..');
const CORPUS_ROOTS = [
	{ dir: path.join(ROOT, 'src', 'test', 'ninja', 'fixtures', 'format'), suffix: '.in.sql' },
	{ dir: path.join(ROOT, 'samples', 'nba-monte-carlo', 'models'), suffix: '.sql' },
	{ dir: path.join(ROOT, 'samples', 'jaffle_shop', 'models'), suffix: '.sql' },
];

function walk(dir: string, suffix: string): string[] {
	if (!fs.existsSync(dir)) return [];
	const out: string[] = [];
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) out.push(...walk(p, suffix));
		else if (e.name.endsWith(suffix)) out.push(p);
	}
	return out;
}

const DELIMS: Record<Exclude<JinjaTokenType, 'text'>, { open: string; close: string }> = {
	expression: { open: '{{', close: '}}' },
	tag: { open: '{%', close: '%}' },
	comment: { open: '{#', close: '#}' },
};

describe('coarseJinjaTokens — corpus parity', () => {
	const files = CORPUS_ROOTS.flatMap(r => walk(r.dir, r.suffix));

	it('covers the expected corpus', () => {
		expect(files.length).toBeGreaterThanOrEqual(91);
	});

	it('tiles the source exactly and respects the delimiter/content contract, on every corpus file', () => {
		for (const f of files) {
			const sql = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
			const rel = path.relative(ROOT, f);
			const toks = viaSqllensStream(sql);

			// (i) Tiling: sorted by start, no gaps, no overlaps, raw matches the slice.
			let cursor = 0;
			for (const t of toks) {
				expect(t.start, `${rel}: token starts where the previous one ended`).toBe(cursor);
				expect(t.raw, `${rel}: raw is exactly source.slice(start, end)`).toBe(sql.slice(t.start, t.end));
				cursor = t.end;
			}
			if (sql.length > 0) {
				expect(toks.length > 0 && toks[0].start === 0 || sql.length === 0, `${rel}: first token starts at 0`).toBe(true);
			}
			expect(cursor, `${rel}: last token ends at source.length`).toBe(sql.length);

			for (let i = 0; i < toks.length; i++) {
				const t = toks[i];

				// (ii) Non-text tokens carry the right 2-char delimiter pair (the 3rd
				// char may be a whitespace-control '-', which is not part of the check).
				if (t.type !== 'text') {
					const { open, close } = DELIMS[t.type];
					expect(t.raw.startsWith(open), `${rel}: ${t.type} token opens with ${open}`).toBe(true);
					expect(t.raw.endsWith(close), `${rel}: ${t.type} token closes with ${close}`).toBe(true);

					// (iii) content === raw with the outer 2 chars stripped both ends.
					expect(t.content, `${rel}: content strips exactly the 2-char delimiters`).toBe(t.raw.slice(2, -2));
				}

				// (iv) No two consecutive tokens are both 'text'.
				if (i > 0) {
					expect(t.type === 'text' && toks[i - 1].type === 'text', `${rel}: no two consecutive text tokens`).toBe(false);
				}
			}
		}
	});
});
