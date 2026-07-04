/**
 * `tagInfos` (R2 tag-AST -> ref/source/macro consumer shapes) versus the legacy
 * jinja-tokenizer extractors, on the SAME snippets used by the extractor tests
 * (src/test/ftl/ftl-document-parser.test.ts). The contract: for SINGLE-LINE tags
 * the two producers are FIELD-FOR-FIELD equal, so swapping refs/sources/macroCalls
 * onto `tagInfos` on the native path is position-preserving (the shadow-diff refs /
 * sources / macroCalls classes cannot grow). The cases where they legitimately
 * differ — multi-line spans, the 2-arg `ref` form, and nested `{{ }}` macro calls —
 * are pinned here with the NEW correct values and a note on WHY, so the divergences
 * are intentional, not regressions.
 */
import { describe, expect, it } from 'vitest';
import { parseTemplated } from './api';
import { tagInfos } from './extract/tag-infos';
import { extractMacroCalls, extractRefs, extractSources } from '../extractors/jinja-tag-extractors';
import { tokenizeJinja } from '../jinja-tokenizer';

function fromTags(sql: string): ReturnType<typeof tagInfos> {
	return tagInfos(parseTemplated(sql, 'databricks').tags, sql);
}

// ---------------------------------------------------------------------------
// refs — field-for-field parity on single-line tags
// ---------------------------------------------------------------------------

describe('tagInfos.refs — field-for-field parity with extractRefs (single-line)', () => {
	const cases = [
		'select * from {{ ref(\'orders\') }}',
		'select 1 from {{ ref(\'a\') }} union all select 2 from {{ ref(\'b\') }}',
		'SELECT id\nFROM {{ ref(\'orders\') }}', // ref on line 1, still a single-line tag
		'select * from {{ ref("dq_orders") }}', // double-quoted model name
	];
	for (const sql of cases) {
		it(`matches extractRefs for ${JSON.stringify(sql)}`, () => {
			expect(fromTags(sql).refs).toEqual(extractRefs(tokenizeJinja(sql)));
		});
	}

	it('produces the documented field values for the canonical ref', () => {
		// select * from {{ ref('orders') }}
		//               ^14 {{   ^17 ref   ^22 model content   ^28 close-quote   ^33 after }}
		expect(fromTags('select * from {{ ref(\'orders\') }}').refs).toEqual([{
			model: 'orders', line: 0, col: 17, modelCol: 22, modelEndCol: 28, jinjaCol: 14, jinjaEndCol: 33,
		}]);
	});
});

describe('tagInfos.refs — deliberate divergences (new is more correct)', () => {
	it('emits a correct ref for the 2-arg ref(\'pkg\',\'model\') form extractRefs drops', () => {
		const sql = 'select * from {{ ref(\'my_pkg\', \'orders\') }}';
		// extractRefs matches only `ref ( STRING )` — the comma breaks the pattern, so
		// the old extractor silently emits NOTHING for the package-qualified 2-arg form.
		expect(extractRefs(tokenizeJinja(sql))).toHaveLength(0);
		// The tag-AST takes the LAST positional string as the model (dbt semantics).
		const refs = fromTags(sql).refs;
		expect(refs).toHaveLength(1);
		expect(refs[0].model).toBe('orders');
		expect(sql.slice(refs[0].modelCol!, refs[0].modelEndCol!)).toBe('orders');
	});

	it('is span-accurate on a multi-line ref (extractRefs was single-line lossy)', () => {
		// The `ref` identifier is on line 1; the model on line 2; the closing `}}` on
		// line 3. Each field derives from its OWN span offset, so every column is real
		// (the old extractor stored one line and computed end columns as col+byteLength).
		const sql = 'select id\nfrom {{ ref(\n  "stg_orders"\n) }}\nwhere id > 0';
		expect(fromTags(sql).refs).toEqual([{
			model: 'stg_orders',
			line: 1, col: 8,        // `ref` identifier on line 1
			modelCol: 3, modelEndCol: 13, // model content on line 2, quotes excluded
			jinjaCol: 5,            // `{{` column on line 1
			jinjaEndCol: 4,         // end of `}}` column on line 3
		}]);
	});
});

// ---------------------------------------------------------------------------
// sources — field-for-field parity on single-line tags (unblocked by the shipped
// `source` callSpan); span-accurate divergence on multi-line.
// ---------------------------------------------------------------------------

describe('tagInfos.sources — field-for-field parity with extractSources (single-line)', () => {
	const cases = [
		'select * from {{ source(\'jaffle_shop\', \'raw_orders\') }}',
		'select * from {{ source("nba", "nba_elo") }}', // double-quoted
		// trailing SQL alias `a` — the alias is back-filled later by enrichment, not by
		// either extractor here, so both produce the same alias-less SourceInfo.
		'from {{ source("nba", "nba_elo") }} a',
	];
	for (const sql of cases) {
		it(`matches extractSources for ${JSON.stringify(sql)}`, () => {
			expect(fromTags(sql).sources).toEqual(extractSources(tokenizeJinja(sql)));
		});
	}

	it('produces the documented field values for the canonical source', () => {
		// select * from {{ source('jaffle_shop', 'raw_orders') }}
		//               ^14 {{  ^17 source  ^25 'jaffle_shop' content  ^49 'raw_orders' content
		expect(fromTags('select * from {{ source(\'jaffle_shop\', \'raw_orders\') }}').sources).toEqual([{
			sourceName: 'jaffle_shop', tableName: 'raw_orders',
			line: 0, col: 17,
			sourceNameCol: 25, sourceNameEndCol: 36,
			tableNameCol: 40, tableNameEndCol: 50,
			jinjaCol: 14, jinjaEndCol: 55,
		}]);
	});
});

describe('tagInfos.sources — deliberate divergence (new is span-accurate)', () => {
	it('is span-accurate on a multi-line source (extractSources was single-line lossy)', () => {
		// The `source` identifier + `{{` are on line 0; the name/table strings on lines 1/2;
		// the closing `}}` on line 3. Each field derives from its OWN span offset, so the
		// closing `jinjaEndCol` is a REAL column (4) on the closing line. The old extractor
		// computed jinjaEndCol as `open.col + byteLength` = 46 — a column that does not exist
		// on any line once the tag wraps.
		const sql = 'select * from {{ source(\n  "sch",\n  "tbl"\n) }}';
		expect(fromTags(sql).sources).toEqual([{
			sourceName: 'sch', tableName: 'tbl',
			line: 0, col: 17,
			sourceNameCol: 3, sourceNameEndCol: 6,
			tableNameCol: 3, tableNameEndCol: 6,
			jinjaCol: 14, jinjaEndCol: 4,
		}]);
		// The old extractor's jinjaEndCol is the single-line-lossy 46.
		expect(extractSources(tokenizeJinja(sql))[0].jinjaEndCol).toBe(46);
	});
});

// ---------------------------------------------------------------------------
// macroCalls — field-for-field parity for single-line expression tags, for
// {% … %} block tags (via `control.calls`), AND for nested calls inside {{ }}
// expression tags (via `macro.calls`, af1170c) — the whole C1 macro surface.
// ---------------------------------------------------------------------------

describe('tagInfos.macroCalls — field-for-field parity with extractMacroCalls (single-line expr)', () => {
	const cases = [
		'select {{ my_macro(\'a\') }} from t',
		'select {{ dbt_utils.pivot(\'col\', [\'a\']) }} from t',   // package-qualified
		'select {{ my_macro(\'a\', \'b\', \'c\') }} from t', // per-arg spans
		// package-qualified with a nested-paren arg: the comma inside `var('a', 2)` must
		// NOT split the outer arg list (2 args: the var(…) call and 'x').
		'select {{ dbt_utils.pivot(var(\'a\', 2), \'x\') }} from t',
	];
	for (const sql of cases) {
		it(`matches extractMacroCalls for ${JSON.stringify(sql)}`, () => {
			expect(fromTags(sql).macroCalls).toEqual(extractMacroCalls(tokenizeJinja(sql)));
		});
	}
});

describe('tagInfos.macroCalls — {% … %} block tags now surface via control.calls', () => {
	const cases = [
		'{% set x = my_macro(1) %}\nselect 1',
		'{% if my_macro() %}select 1{% endif %}',
		'{% for x in my_macro() %}select 1{% endfor %}',
		'{% call my_macro() %}body{% endcall %}\nselect 1',
		'{% do run_query(my_macro()) %}\nselect 1', // do-block, two calls (source order)
	];
	for (const sql of cases) {
		it(`matches extractMacroCalls for ${JSON.stringify(sql)}`, () => {
			expect(fromTags(sql).macroCalls).toEqual(extractMacroCalls(tokenizeJinja(sql)));
		});
	}

	it('skips the macro DEFINITION site — {% macro foo(a) %} emits no call for foo', () => {
		// The old extractor skips a callee immediately preceded by the `macro` keyword;
		// the tag-AST surfaces `foo` in control.calls, so tagInfos drops the declaration
		// (name === the declared macro name) to match.
		const sql = '{% macro foo(a) %}\nselect 1';
		expect(extractMacroCalls(tokenizeJinja(sql))).toEqual([]);
		expect(fromTags(sql).macroCalls).toEqual([]);
	});

	it('does NOT emit ref / source / config / var / env_var callees as macro calls', () => {
		for (const sql of [
			'{% if config(materialized=\'x\') %}select 1{% endif %}', // config inside a control tag
			'select {{ config(materialized=\'table\') }}',
			'select {{ var(\'x\') }}',
			'select {{ env_var(\'X\') }}',
		]) {
			expect(fromTags(sql).macroCalls).toEqual(extractMacroCalls(tokenizeJinja(sql)));
			expect(fromTags(sql).macroCalls).toEqual([]);
		}
	});
});

describe('tagInfos.macroCalls — nested {{ }} expression calls now surface via macro.calls (af1170c)', () => {
	it('emits BOTH outer and inner, field-for-field with extractMacroCalls', () => {
		// af1170c gave the expression `macro` node `calls: MacroCall[]` (source order, nested
		// included, symmetric to control.calls), so the inner call is no longer dropped — the
		// last C1 field gap. Full parity with the old paren-scan; macroCalls come off tags now.
		const sql = 'select {{ outer(inner(1, 2), 3) }} from t';
		expect(fromTags(sql).macroCalls).toEqual(extractMacroCalls(tokenizeJinja(sql)));
		// source order: outer (the top-level call) before its nested inner.
		expect(fromTags(sql).macroCalls.map(m => m.name)).toEqual(['outer', 'inner']);
	});
});
