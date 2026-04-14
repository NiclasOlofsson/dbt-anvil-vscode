import { describe, it, expect } from 'vitest';
import { emptyModel, mockDocument, cfg, violationsFor } from './helpers';
import { runNinja } from '../../ninja/engine';

const RULE = 'ninja.jinja.padding';

function runJinja(sql: string) {
	const doc = mockDocument(sql);
	return runNinja(doc, emptyModel, [], cfg());
}

describe(RULE, () => {
	// ── Missing padding ────────────────────────────────────────────────────

	it('flags missing space in expression delimiter', () => {
		const v = violationsFor(runJinja('{{ref("orders")}}'), RULE);
		expect(v.length).toBeGreaterThan(0);
	});

	it('flags missing space in tag delimiter', () => {
		const v = violationsFor(runJinja('{%if true%}'), RULE);
		expect(v.length).toBeGreaterThan(0);
	});

	// ── Correct padding ────────────────────────────────────────────────────

	it('passes properly padded expression', () => {
		const v = violationsFor(runJinja('{{ ref("orders") }}'), RULE);
		expect(v.length).toBe(0);
	});

	it('passes properly padded tag', () => {
		const v = violationsFor(runJinja('{% if true %}'), RULE);
		expect(v.length).toBe(0);
	});

	// ── Whitespace-control dashes ──────────────────────────────────────────

	it('passes padded expression with whitespace-control dashes', () => {
		const v = violationsFor(runJinja('{{- ref("orders") -}}'), RULE);
		expect(v.length).toBe(0);
	});

	it('flags missing space after dash in expression', () => {
		const v = violationsFor(runJinja('{{-ref("orders")-}}'), RULE);
		expect(v.length).toBeGreaterThan(0);
	});

	it('passes padded tag with whitespace-control dashes', () => {
		const v = violationsFor(runJinja('{%- if true -%}'), RULE);
		expect(v.length).toBe(0);
	});

	// ── Multiple spaces ────────────────────────────────────────────────────

	it('flags multiple spaces after opening delimiter', () => {
		const v = violationsFor(runJinja('{{  ref("orders") }}'), RULE);
		expect(v.length).toBeGreaterThan(0);
	});

	it('flags multiple spaces before closing delimiter', () => {
		const v = violationsFor(runJinja('{{ ref("orders")  }}'), RULE);
		expect(v.length).toBeGreaterThan(0);
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('provides insert fix for missing opening space', () => {
		const r = runJinja('{{ref("orders") }}');
		const v = violationsFor(r, RULE);
		const openingFix = v.find(x => x.message.includes('after'));
		expect(openingFix).toBeDefined();
		expect(openingFix!.fix).toBeDefined();
	});

	it('provides insert fix for missing closing space', () => {
		const r = runJinja('{{ ref("orders")}}');
		const v = violationsFor(r, RULE);
		const closingFix = v.find(x => x.message.includes('before'));
		expect(closingFix).toBeDefined();
		expect(closingFix!.fix).toBeDefined();
	});

	// ── Mixed SQL + Jinja ──────────────────────────────────────────────────

	it('checks jinja inside SQL', () => {
		const v = violationsFor(runJinja('select * from {{ref("orders")}}'), RULE);
		expect(v.length).toBeGreaterThan(0);
	});

	it('passes padded jinja inside SQL', () => {
		const v = violationsFor(runJinja('select * from {{ ref("orders") }}'), RULE);
		expect(v.length).toBe(0);
	});

	// ── Multiple jinja tags ────────────────────────────────────────────────

	it('checks multiple jinja expressions', () => {
		const v = violationsFor(runJinja('{{ref("a")}} and {{ref("b")}}'), RULE);
		// Both should be flagged (missing spaces in both)
		expect(v.length).toBeGreaterThanOrEqual(2);
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('handles empty document', () => {
		const v = violationsFor(runJinja(''), RULE);
		expect(v.length).toBe(0);
	});

	it('handles no jinja in document', () => {
		const v = violationsFor(runJinja('select 1 from t'), RULE);
		expect(v.length).toBe(0);
	});

	it('handles jinja comment (should be skipped)', () => {
		const v = violationsFor(runJinja('{# this is a comment #}'), RULE);
		expect(v.length).toBe(0);
	});

	// ── Multi-line blocks ──────────────────────────────────────────────────

	it('passes multiline config block (newline after opening)', () => {
		const sql = '{{\n    config(\n        materialized="table"\n    )\n}}';
		const v = violationsFor(runJinja(sql), RULE);
		expect(v.length).toBe(0);
	});

	it('passes multiline block with no spaces at delimiters', () => {
		const sql = '{{\nconfig(\n    materialized="table"\n)\n}}';
		const v = violationsFor(runJinja(sql), RULE);
		expect(v.length).toBe(0);
	});
});
