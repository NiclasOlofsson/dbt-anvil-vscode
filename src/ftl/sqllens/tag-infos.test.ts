/**
 * `tagInfos` (R2 tag-AST -> ref/source/macro consumer shapes): the position
 * contract every consumer depends on, pinned field-for-field. The expected
 * values are frozen from the verified migration corpus — every column here is
 * a real (line, col) in the raw source, so a drift in any field is a consumer
 * regression (enrichment back-fill keys on `line` + `jinjaCol`; rename and
 * signature-help read the content and arg spans).
 *
 * Two behaviors are deliberately richer than a naive single-line scan and are
 * pinned with a note on WHY:
 *   - MULTI-LINE tags: each field's line/col derives from ITS OWN span offset,
 *     so wrapped tags stay span-accurate.
 *   - 2-ARGUMENT `ref('pkg','model')`: the LAST positional string is the model
 *     (dbt's actual semantics).
 */
import { describe, expect, it } from 'vitest';
import { parseTemplated } from './api';
import { tagInfos } from './extract/tag-infos';

function fromTags(sql: string): ReturnType<typeof tagInfos> {
	return tagInfos(parseTemplated(sql, 'databricks').tags);
}

// ---------------------------------------------------------------------------
// refs — pinned field-for-field on single-line tags
// ---------------------------------------------------------------------------

describe('tagInfos.refs — pinned fields (single-line)', () => {
	it('canonical single ref', () => {
		// select * from {{ ref('orders') }}
		//               ^14 {{   ^17 ref   ^22 model content   ^28 close-quote   ^33 after }}
		expect(fromTags('select * from {{ ref(\'orders\') }}').refs).toEqual([{
			model: 'orders', line: 0, col: 17, modelCol: 22, modelEndCol: 28, jinjaCol: 14, jinjaEndCol: 33,
		}]);
	});

	it('two refs on one line', () => {
		expect(fromTags('select 1 from {{ ref(\'a\') }} union all select 2 from {{ ref(\'b\') }}').refs).toEqual([
			{ model: 'a', line: 0, col: 17, modelCol: 22, modelEndCol: 23, jinjaCol: 14, jinjaEndCol: 28 },
			{ model: 'b', line: 0, col: 56, modelCol: 61, modelEndCol: 62, jinjaCol: 53, jinjaEndCol: 67 },
		]);
	});

	it('ref on line 1 (still a single-line tag)', () => {
		expect(fromTags('SELECT id\nFROM {{ ref(\'orders\') }}').refs).toEqual([{
			model: 'orders', line: 1, col: 8, modelCol: 13, modelEndCol: 19, jinjaCol: 5, jinjaEndCol: 24,
		}]);
	});

	it('double-quoted model name', () => {
		expect(fromTags('select * from {{ ref("dq_orders") }}').refs).toEqual([{
			model: 'dq_orders', line: 0, col: 17, modelCol: 22, modelEndCol: 31, jinjaCol: 14, jinjaEndCol: 36,
		}]);
	});
});

describe('tagInfos.refs — richer-than-single-line-scan behaviors', () => {
	it('emits a correct ref for the 2-arg ref(\'pkg\',\'model\') form', () => {
		// The tag-AST takes the LAST positional string as the model (dbt semantics).
		const refs = fromTags('select * from {{ ref(\'my_pkg\', \'orders\') }}').refs;
		expect(refs).toHaveLength(1);
		expect(refs[0].model).toBe('orders');
		const sql = 'select * from {{ ref(\'my_pkg\', \'orders\') }}';
		expect(sql.slice(refs[0].modelCol!, refs[0].modelEndCol!)).toBe('orders');
	});

	it('is span-accurate on a multi-line ref', () => {
		// The `ref` identifier is on line 1; the model on line 2; the closing `}}` on
		// line 3. Each field derives from its OWN span offset, so every column is real.
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
// sources — pinned field-for-field on single-line tags; span-accurate multi-line.
// ---------------------------------------------------------------------------

describe('tagInfos.sources — pinned fields (single-line)', () => {
	it('canonical source', () => {
		// select * from {{ source('jaffle_shop', 'raw_orders') }}
		//               ^14 {{  ^17 source  ^25 'jaffle_shop' content  ^40 'raw_orders' content
		expect(fromTags('select * from {{ source(\'jaffle_shop\', \'raw_orders\') }}').sources).toEqual([{
			sourceName: 'jaffle_shop', tableName: 'raw_orders',
			line: 0, col: 17,
			sourceNameCol: 25, sourceNameEndCol: 36,
			tableNameCol: 40, tableNameEndCol: 50,
			jinjaCol: 14, jinjaEndCol: 55,
		}]);
	});

	it('double-quoted source', () => {
		expect(fromTags('select * from {{ source("nba", "nba_elo") }}').sources).toEqual([{
			sourceName: 'nba', tableName: 'nba_elo',
			line: 0, col: 17,
			sourceNameCol: 25, sourceNameEndCol: 28,
			tableNameCol: 32, tableNameEndCol: 39,
			jinjaCol: 14, jinjaEndCol: 44,
		}]);
	});

	it('trailing SQL alias is not consumed here (back-filled later by enrichment)', () => {
		expect(fromTags('from {{ source("nba", "nba_elo") }} a').sources).toEqual([{
			sourceName: 'nba', tableName: 'nba_elo',
			line: 0, col: 8,
			sourceNameCol: 16, sourceNameEndCol: 19,
			tableNameCol: 23, tableNameEndCol: 30,
			jinjaCol: 5, jinjaEndCol: 35,
		}]);
	});

	it('is span-accurate on a multi-line source', () => {
		// The `source` identifier + `{{` are on line 0; the name/table strings on lines 1/2;
		// the closing `}}` on line 3. Each field derives from its OWN span offset, so the
		// closing `jinjaEndCol` is a REAL column (4) on the closing line — never a
		// fabricated `open.col + byteLength` column that exists on no line.
		const sql = 'select * from {{ source(\n  "sch",\n  "tbl"\n) }}';
		expect(fromTags(sql).sources).toEqual([{
			sourceName: 'sch', tableName: 'tbl',
			line: 0, col: 17,
			sourceNameCol: 3, sourceNameEndCol: 6,
			tableNameCol: 3, tableNameEndCol: 6,
			jinjaCol: 14, jinjaEndCol: 4,
		}]);
	});
});

// ---------------------------------------------------------------------------
// macroCalls — pinned for single-line expression tags, for {% … %} block tags
// (via `control.calls`), AND for nested calls inside {{ }} expression tags
// (via `macro.calls`) — the whole macro surface.
// ---------------------------------------------------------------------------

describe('tagInfos.macroCalls — pinned fields (expression tags)', () => {
	it('single-arg macro', () => {
		expect(fromTags('select {{ my_macro(\'a\') }} from t').macroCalls).toEqual([{
			name: 'my_macro', line: 0, col: 10, endCol: 18,
			jinjaCol: 7, jinjaEndCol: 26, jinjaLine: 0,
			argsCol: 18, argsEndCol: 23,
			args: [{ line: 0, col: 19, endCol: 22 }],
		}]);
	});

	it('package-qualified macro', () => {
		expect(fromTags('select {{ dbt_utils.pivot(\'col\', [\'a\']) }} from t').macroCalls).toEqual([{
			name: 'pivot', packageName: 'dbt_utils',
			line: 0, col: 20, endCol: 25,
			packageCol: 10, packageEndCol: 19,
			jinjaCol: 7, jinjaEndCol: 42, jinjaLine: 0,
			argsCol: 25, argsEndCol: 39,
			args: [{ line: 0, col: 26, endCol: 31 }, { line: 0, col: 33, endCol: 38 }],
		}]);
	});

	it('per-arg spans on a 3-arg macro', () => {
		expect(fromTags('select {{ my_macro(\'a\', \'b\', \'c\') }} from t').macroCalls).toEqual([{
			name: 'my_macro', line: 0, col: 10, endCol: 18,
			jinjaCol: 7, jinjaEndCol: 36, jinjaLine: 0,
			argsCol: 18, argsEndCol: 33,
			args: [
				{ line: 0, col: 19, endCol: 22 },
				{ line: 0, col: 24, endCol: 27 },
				{ line: 0, col: 29, endCol: 32 },
			],
		}]);
	});

	it('nested-paren arg does not split the outer arg list', () => {
		// The comma inside `var('a', 2)` must NOT split the outer list (2 args:
		// the var(…) call and 'x'). `var` itself is a dbt global, never a macro call.
		expect(fromTags('select {{ dbt_utils.pivot(var(\'a\', 2), \'x\') }} from t').macroCalls).toEqual([{
			name: 'pivot', packageName: 'dbt_utils',
			line: 0, col: 20, endCol: 25,
			packageCol: 10, packageEndCol: 19,
			jinjaCol: 7, jinjaEndCol: 46, jinjaLine: 0,
			argsCol: 25, argsEndCol: 43,
			args: [{ line: 0, col: 26, endCol: 37 }, { line: 0, col: 39, endCol: 42 }],
		}]);
	});
});

describe('tagInfos.macroCalls — {% … %} block tags surface via control.calls', () => {
	it('{% set x = my_macro(1) %}', () => {
		expect(fromTags('{% set x = my_macro(1) %}\nselect 1').macroCalls).toEqual([{
			name: 'my_macro', line: 0, col: 11, endCol: 19,
			jinjaCol: 0, jinjaEndCol: 25, jinjaLine: 0,
			argsCol: 19, argsEndCol: 22,
			args: [{ line: 0, col: 20, endCol: 21 }],
		}]);
	});

	it('{% if my_macro() %}', () => {
		expect(fromTags('{% if my_macro() %}select 1{% endif %}').macroCalls).toEqual([{
			name: 'my_macro', line: 0, col: 6, endCol: 14,
			jinjaCol: 0, jinjaEndCol: 19, jinjaLine: 0,
			argsCol: 14, argsEndCol: 16,
			args: [],
		}]);
	});

	it('{% for x in my_macro() %}', () => {
		expect(fromTags('{% for x in my_macro() %}select 1{% endfor %}').macroCalls).toEqual([{
			name: 'my_macro', line: 0, col: 12, endCol: 20,
			jinjaCol: 0, jinjaEndCol: 25, jinjaLine: 0,
			argsCol: 20, argsEndCol: 22,
			args: [],
		}]);
	});

	it('{% call my_macro() %}', () => {
		expect(fromTags('{% call my_macro() %}body{% endcall %}\nselect 1').macroCalls).toEqual([{
			name: 'my_macro', line: 0, col: 8, endCol: 16,
			jinjaCol: 0, jinjaEndCol: 21, jinjaLine: 0,
			argsCol: 16, argsEndCol: 18,
			args: [],
		}]);
	});

	it('{% do run_query(my_macro()) %} — two calls, source order', () => {
		expect(fromTags('{% do run_query(my_macro()) %}\nselect 1').macroCalls).toEqual([
			{
				name: 'run_query', line: 0, col: 6, endCol: 15,
				jinjaCol: 0, jinjaEndCol: 30, jinjaLine: 0,
				argsCol: 15, argsEndCol: 27,
				args: [{ line: 0, col: 16, endCol: 26 }],
			},
			{
				name: 'my_macro', line: 0, col: 16, endCol: 24,
				jinjaCol: 0, jinjaEndCol: 30, jinjaLine: 0,
				argsCol: 24, argsEndCol: 26,
				args: [],
			},
		]);
	});

	it('skips the macro DEFINITION site — {% macro foo(a) %} emits no call for foo', () => {
		// The tag-AST surfaces `foo` in control.calls, so tagInfos drops the
		// declaration (name === the declared macro name).
		expect(fromTags('{% macro foo(a) %}\nselect 1').macroCalls).toEqual([]);
	});

	it('does NOT emit ref / source / config / var / env_var callees as macro calls', () => {
		for (const sql of [
			'{% if config(materialized=\'x\') %}select 1{% endif %}', // config inside a control tag
			'select {{ config(materialized=\'table\') }}',
			'select {{ var(\'x\') }}',
			'select {{ env_var(\'X\') }}',
		]) {
			expect(fromTags(sql).macroCalls).toEqual([]);
		}
	});
});

describe('tagInfos.macroCalls — nested {{ }} expression calls surface via macro.calls', () => {
	it('emits BOTH outer and inner, source order, with full spans', () => {
		expect(fromTags('select {{ outer(inner(1, 2), 3) }} from t').macroCalls).toEqual([
			{
				name: 'outer', line: 0, col: 10, endCol: 15,
				jinjaCol: 7, jinjaEndCol: 34, jinjaLine: 0,
				argsCol: 15, argsEndCol: 31,
				args: [{ line: 0, col: 16, endCol: 27 }, { line: 0, col: 29, endCol: 30 }],
			},
			{
				name: 'inner', line: 0, col: 16, endCol: 21,
				jinjaCol: 7, jinjaEndCol: 34, jinjaLine: 0,
				argsCol: 21, argsEndCol: 27,
				args: [{ line: 0, col: 22, endCol: 23 }, { line: 0, col: 25, endCol: 26 }],
			},
		]);
	});
});
