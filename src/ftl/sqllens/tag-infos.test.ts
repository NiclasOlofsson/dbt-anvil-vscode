/**
 * `tagInfos` (R2 tag-AST -> ref/source/macro consumer shapes) versus the legacy
 * jinja-tokenizer extractors, on the SAME snippets used by the extractor tests
 * (src/test/ftl/ftl-document-parser.test.ts). The contract: for SINGLE-LINE tags
 * the two producers are FIELD-FOR-FIELD equal, so swapping refs onto `tagInfos`
 * on the native path is position-preserving (the shadow-diff refs class cannot
 * grow). The cases where they legitimately differ — multi-line spans, the 2-arg
 * `ref` form, nested/block-tag macro calls, sources — are pinned here with the
 * NEW correct values and a note on WHY, so the divergences are intentional, not
 * regressions.
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
// sources — blocked: the source tag node has no callee span
// ---------------------------------------------------------------------------

describe('tagInfos.sources — blocked (source tag has no callee span)', () => {
	it('emits nothing while extractSources produces the SourceInfo (documented gap)', () => {
		const sql = 'select * from {{ source(\'jaffle_shop\', \'raw_orders\') }}';
		// `SourceInfo.col` is the column of the bare `source` identifier; the source
		// TagNode carries sourceName/tableName/tag spans but NO callee span, so col is
		// underivable. tagInfos emits nothing; sources stay on extractSources.
		expect(fromTags(sql).sources).toEqual([]);
		expect(extractSources(tokenizeJinja(sql))).toHaveLength(1);
	});
});

// ---------------------------------------------------------------------------
// macroCalls — field-for-field parity for single-line expression tags;
// documented gaps for nested calls and {% … %} block tags.
// ---------------------------------------------------------------------------

describe('tagInfos.macroCalls — field-for-field parity with extractMacroCalls (single-line expr)', () => {
	const cases = [
		'select {{ my_macro(\'a\') }} from t',
		'select {{ dbt_utils.pivot(\'col\', [\'a\']) }} from t', // package-qualified
		'select {{ my_macro(\'a\', \'b\', \'c\') }} from t',       // per-arg spans
	];
	for (const sql of cases) {
		it(`matches extractMacroCalls for ${JSON.stringify(sql)}`, () => {
			expect(fromTags(sql).macroCalls).toEqual(extractMacroCalls(tokenizeJinja(sql)));
		});
	}

	it('splits args at the top level only, matching the old extractor for the outer call', () => {
		// Nested parens: `inner(1, 2)` is ONE arg. The old extractor emits BOTH outer and
		// inner; the tag-AST emits only the top-level `outer`, but the OUTER call's fields
		// (including its two args) match field-for-field.
		const sql = 'select {{ outer(inner(1, 2), \'x\') }} from t';
		const tagOuter = fromTags(sql).macroCalls.find(m => m.name === 'outer')!;
		const oldOuter = extractMacroCalls(tokenizeJinja(sql)).find(m => m.name === 'outer')!;
		expect(tagOuter).toEqual(oldOuter);
		expect(tagOuter.args).toHaveLength(2);
	});
});

describe('tagInfos.macroCalls — coverage gaps (why macros stay on the old extractor)', () => {
	it('captures only the top-level call for nested macros (old emits both levels)', () => {
		const sql = 'select {{ outer(inner(1)) }} from t';
		expect(extractMacroCalls(tokenizeJinja(sql)).map(m => m.name).sort()).toEqual(['inner', 'outer']);
		expect(fromTags(sql).macroCalls.map(m => m.name)).toEqual(['outer']);
	});

	it('does not cover {% set/if/call %} block-tag macro calls (R2 emits control nodes)', () => {
		for (const sql of [
			'{% set rows = my_macro(\'a\') %}\nselect 1',
			'{% if my_macro(\'x\') %}select 1{% endif %}',
			'{% call my_macro() %}body{% endcall %}\nselect 1',
		]) {
			// The old extractor DOES capture the block-tag macro call...
			expect(extractMacroCalls(tokenizeJinja(sql)).some(m => m.name === 'my_macro')).toBe(true);
			// ...the tag-AST classifies the whole `{% … %}` as a control node, so no macro
			// call surfaces. Hence macros stay on extractMacroCalls on the live path.
			expect(fromTags(sql).macroCalls).toEqual([]);
		}
	});
});
