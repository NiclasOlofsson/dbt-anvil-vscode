/**
 * Receiving inspection for sqllens ITEM 10 increment 1 (jinja-SQL front end,
 * sqllens master 31627ac). Validates that `parseTemplated` meets the extension's
 * R2 consumption contract (src/ftl/sqllens/JINJA-CONSUMPTION-PLAN.md) IN PRACTICE
 * before we integrate it — the exact span fields our ref/source/macro extractors
 * and signature-help need, the unified channel-0-SQL + channel-2-jinja stream, and
 * the no-output-aware placeholder default (the config-topped-model fix, CHANNEL
 * ITEM 10 flag). Test-only: imports sqllens, touches nothing in the live parse path.
 */
import { describe, expect, it } from 'vitest';
import { parseTemplated } from '../../../ftl/sqllens/api';
import type { TagNode, PartSpan } from '../../../ftl/sqllens/api';

/** Slice the original document at a PartSpan (absolute 0-based offsets, end exclusive). */
function slice(sql: string, span: PartSpan): string {
	return sql.slice(span.start, span.end);
}

function tagsOfKind<K extends TagNode['kind']>(tags: TagNode[], kind: K): Extract<TagNode, { kind: K }>[] {
	return tags.filter((t): t is Extract<TagNode, { kind: K }> => t.kind === kind);
}

// Since sqllens 1.2.0 the tag-AST is dbt-agnostic: every `{{ … }}` expression is a
// `call` node (kind 'call') carrying `name` + `args: TagArg[]` (each arg's quote-excluded
// literal in `value`/`valueSpan`). The ref/source/macro roles are the consumer's, derived
// from the callee name — exactly what tag-infos.ts does. This inspection asserts the same
// facts it always did, through the new shape.
const callsNamed = (tags: TagNode[], name: string) =>
	tagsOfKind(tags, 'call').filter(t => t.name === name);

describe('sqllens jinja inc1 — R2 tag-AST span contract', () => {
	it('ref call: model as last arg value + quotes-excluded valueSpan + whole-tag tagSpan', () => {
		const sql = 'select id from {{ ref("stg_orders") }}';
		const { tags } = parseTemplated(sql, 'databricks');
		const refs = callsNamed(tags, 'ref');
		expect(refs).toHaveLength(1);
		const model = refs[0].args[refs[0].args.length - 1]; // dbt: model is the last arg
		expect(model.value).toBe('stg_orders');
		// valueSpan is the string CONTENT, quotes excluded — slices to the bare name.
		expect(slice(sql, model.valueSpan!)).toBe('stg_orders');
		// tagSpan covers the whole {{ ... }} including delimiters.
		expect(slice(sql, refs[0].tagSpan)).toBe('{{ ref("stg_orders") }}');
	});

	it('source call: both name contents + their valueSpans + tagSpan', () => {
		const sql = 'select * from {{ source(\'raw\', \'orders\') }}';
		const { tags } = parseTemplated(sql, 'databricks');
		const srcs = callsNamed(tags, 'source');
		expect(srcs).toHaveLength(1);
		const s = srcs[0];
		expect([s.args[0].value, s.args[1].value]).toEqual(['raw', 'orders']);
		expect(slice(sql, s.args[0].valueSpan!)).toBe('raw');
		expect(slice(sql, s.args[1].valueSpan!)).toBe('orders');
		expect(slice(sql, s.tagSpan)).toBe('{{ source(\'raw\', \'orders\') }}');
	});

	it('macro call: name + package + PER-ARGUMENT spans (the signature-help contract)', () => {
		const sql = 'select {{ dbt_utils.dateadd(\'day\', 7, \'created_at\') }} from t';
		const { tags } = parseTemplated(sql, 'databricks');
		const macros = callsNamed(tags, 'dateadd');
		expect(macros).toHaveLength(1);
		const m = macros[0];
		expect(m.name).toBe('dateadd');
		expect(m.packageName).toBe('dbt_utils');
		// Three args, each with its own span — positions signature help on the active arg.
		expect(m.args).toHaveLength(3);
		expect(m.args.map(a => slice(sql, a.span).trim())).toEqual(['\'day\'', '7', '\'created_at\'']);
	});

	it('nested macro args split at top level only (nested parens respected)', () => {
		const sql = 'select {{ outer(inner(1, 2), 3) }} from t';
		const { tags } = parseTemplated(sql, 'databricks');
		const m = callsNamed(tags, 'outer')[0];
		expect(m.name).toBe('outer');
		expect(m.args).toHaveLength(2); // inner(1,2) is ONE arg, not split on its inner comma
		expect(slice(sql, m.args[0].span).trim()).toBe('inner(1, 2)');
	});

	it('computed ref: model arg is null — never a fabricated model (never-wrong)', () => {
		const sql = 'select 1 from {{ ref(var(\'which\')) }}';
		const { tags } = parseTemplated(sql, 'databricks');
		// The tag IS a ref call, but its model arg is computed, so `value` is null — the
		// consumer (emittedTagKind) declines to emit a RefInfo from it.
		const refs = callsNamed(tags, 'ref');
		expect(refs).toHaveLength(1);
		expect(refs[0].args[refs[0].args.length - 1].value).toBeNull();
	});

	it('multi-line tag carries a correct multi-line span (the parity upgrade)', () => {
		const sql = 'select id\nfrom {{ ref(\n  "stg_orders"\n) }}\nwhere id > 0';
		const { tags } = parseTemplated(sql, 'databricks');
		const model = callsNamed(tags, 'ref')[0].args.at(-1)!;
		expect(model.value).toBe('stg_orders');
		expect(slice(sql, model.valueSpan!)).toBe('stg_orders'); // span correct across the newlines
	});
});

describe('sqllens jinja inc1 — no-output-aware default (the config flag)', () => {
	it('a config-topped model parses with NO fatal SQL diagnostic', () => {
		// The flag: a blanket identifier placeholder for {{ config() }} at statement
		// position is a syntax error; the no-output-aware default whitespaces it so the
		// model parses. This is nearly every real dbt model.
		const sql = '{{ config(materialized=\'table\') }}\nselect id, amount from orders';
		const { tags, sql: sqlResult } = parseTemplated(sql, 'databricks');
		expect(callsNamed(tags, 'config')).toHaveLength(1);
		// The SQL under the placeholder parses — config vanished, not an identifier.
		expect(sqlResult.errors).toBe(0);
	});

	it('statement-level no-output macros (docs/print/…) also do not break the parse', () => {
		const sql = '{{ config(enabled=true) }}\nselect 1 as x';
		const { sql: sqlResult } = parseTemplated(sql, 'databricks');
		expect(sqlResult.errors).toBe(0);
	});
});

describe('sqllens jinja inc1 — R1 unified stream (channels)', () => {
	it('emits jinja tokens on channel 2 alongside channel-0 SQL tokens', () => {
		const sql = 'select id from {{ ref("x") }}';
		const { tokens } = parseTemplated(sql, 'databricks');
		const jinja = tokens.filter(t => t.channel === 2);
		const sqlToks = tokens.filter(t => t.channel === 0);
		expect(jinja.length).toBeGreaterThan(0); // the {{ ref("x") }} tag interior
		expect(sqlToks.length).toBeGreaterThan(0); // select / id / from
		// The stream is source-ordered.
		const offsets = tokens.map(t => t.start);
		expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
	});
});
