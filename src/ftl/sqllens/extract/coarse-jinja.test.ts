/**
 * A/B parity: `coarseJinjaTokens` (coarse per-tag stream grouped from the fine
 * jinja stream) versus `src/dbt/jinja-tokenizer.ts`'s own `tokenize` — the ninja
 * engine's token currency. The consumers (layout rules, jinja-padding, the
 * ambiguity rule's tag scan) must see NOTHING change when the producer swaps,
 * so the outputs are FIELD-FOR-FIELD deep-equal on every well-formed shape,
 * through BOTH feeders:
 *   - the extension's `tokenizeJinja` fine stream (legacy-fed models), and
 *   - sqllens's unified templated stream via `jinjaTokensFromStream` (native).
 *
 * The `--` line-comment skip is load-bearing (rules must not flag jinja on
 * commented-out lines) and is pinned explicitly, including the two quirk edges
 * of the old scanner it reproduces: a `--` inside a string literal still skips
 * (text mode never tracked quotes), and a `--` inside a tag body never skips.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseTemplated } from '../api';
import { jinjaTokensFromStream } from './jinja-stream';
import { coarseJinjaTokens, coarseJinjaTokensFromText } from './coarse-jinja';
import { referenceTokenizeJinja as tokenizeJinja } from '../../../test/ftl/reference-jinja-tokenizers';
import { referenceCoarseTokenize as oracleTokenize } from '../../../test/ftl/reference-jinja-tokenizers';

function viaFineStream(sql: string): ReturnType<typeof coarseJinjaTokens> {
	return coarseJinjaTokens(tokenizeJinja(sql), sql);
}

function viaSqllensStream(sql: string): ReturnType<typeof coarseJinjaTokens> {
	const t = parseTemplated(sql, 'databricks');
	return coarseJinjaTokens(jinjaTokensFromStream(t.tokens, t.tags, sql), sql);
}

const battery: Record<string, string> = {
	'plain text, no jinja': 'select 1 from t\nwhere x = 2',
	'single ref': 'select * from {{ ref(\'orders\') }}',
	'tag at start of source': '{{ config(materialized=\'table\') }}\nselect 1',
	'tag at end of source': 'select * from {{ ref(\'orders\') }}',
	'adjacent tags, no text between': 'select * from {{ ref(\'a\') }}{{ ref(\'b\') }}',
	'block tag': '{% set x = 1 %}\nselect {{ x }}',
	'comment tag': 'select 1 {# a comment #}',
	'whitespace-control dashes kept in content': '{{- ref(\'a\') -}}\n{%- if x -%}\nselect 1\n{%- endif -%}',
	'multi-line tag': 'select\n  {{ my_macro(a,\n     b) }}\nfrom t',
	'quoted close delimiters inside tag': '{{ config(post_hook="insert {{ this }}") }}\nselect 1',
	'jinja after -- is text (line-comment skip)': 'select 1 -- {{ ref(\'a\') }}\nfrom {{ ref(\'b\') }}',
	'-- inside a string still skips (old-scanner quirk)': 'select \'a--b\' {{ ref(\'x\') }}\nfrom {{ ref(\'y\') }}',
	'-- inside a tag body does not skip': 'select {{ f(\'--\') }} from t',
	'-- at end of line, tag on next line': 'select 1 --\nfrom {{ ref(\'a\') }}',
};

describe('coarseJinjaTokens — deep-equal with dbt/jinja-tokenizer over the battery', () => {
	for (const [name, sql] of Object.entries(battery)) {
		it(`matches via the fine stream for ${name}`, () => {
			expect(viaFineStream(sql)).toEqual(oracleTokenize(sql));
		});
		it(`matches via the sqllens stream for ${name}`, () => {
			expect(viaSqllensStream(sql)).toEqual(oracleTokenize(sql));
		});
	}

	it('coarseJinjaTokensFromText equals the sqllens-stream route', () => {
		const sql = battery['single ref'];
		expect(coarseJinjaTokensFromText(sql)).toEqual(viaSqllensStream(sql));
	});
});

// ---------------------------------------------------------------------------
// Corpus sweep — every model the shadow-diff corpus covers, both feeders.
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

describe('coarseJinjaTokens — corpus parity', () => {
	const files = CORPUS_ROOTS.flatMap(r => walk(r.dir, r.suffix));

	it('covers the expected corpus', () => {
		expect(files.length).toBeGreaterThanOrEqual(91);
	});

	it('matches the oracle on every corpus file, via both feeders', () => {
		for (const f of files) {
			const sql = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
			const oracle = oracleTokenize(sql);
			expect(viaFineStream(sql), `fine stream: ${path.relative(ROOT, f)}`).toEqual(oracle);
			expect(viaSqllensStream(sql), `sqllens stream: ${path.relative(ROOT, f)}`).toEqual(oracle);
		}
	});
});
