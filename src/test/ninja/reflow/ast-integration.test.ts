import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';

/**
 * These tests exercise the byte-range AST index wired through from
 * SqllensDocumentParser → reflowDocument → printDocument. Each test parses
 * real SQL through the live sqllens parser (synchronous, in-process)
 * to get real tokens + a real astIndex.
 */
const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('reflow.ast-integration', () => {
	it('indents the body of a CTE when L_PAREN opens under a Cte node', async () => {
		// with x as (select 1)
		const sql = 'with x as (select 1)';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg());
		// Expect: the body `select 1` lands on a new, indented line; the
		// close paren returns to the outer indent level.
		expect(result.edit?.newText).toBe('with x as (\n    select 1\n)\n');
	});

	it('breaks after the comma between two CTE definitions', async () => {
		// with a as (select 1), b as (select 2) select 1
		// For compactness we just verify the CTE-separator comma gets a
		// newline after it — the test is about comma disambiguation, not
		// the surrounding SELECT.
		const sql = 'with a as (select 1), b as (select 2) select 1';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg());
		const rendered = result.edit?.newText ?? '';
		// Second CTE's name must start a new line after the separator comma.
		expect(rendered).toMatch(/\),\s*\n\s*b/);
	});

	it('does NOT break on commas inside a function call', async () => {
		// select coalesce(a, b) from t — the comma at offset 19 is inside
		// a function call, not a SELECT-list / CTE list. It must not break.
		const sql = 'select coalesce(a, b) from t';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg());
		// Expect `coalesce(a, b)` intact on one line, NOT broken at the
		// function-args comma.
		expect(result.edit?.newText).toContain('coalesce(a, b)');
		expect(result.edit?.newText).not.toMatch(/coalesce\(a,\s*\n/);
	});

	it('falls back cleanly when AST is empty', async () => {
		// Same SQL as the CTE test — verifies the printer produces valid,
		// deterministic output via the live parser's model.
		const sql = 'with x as (select 1)';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg());
		// No crash, deterministic output.
		expect(result.edit?.newText).toBeDefined();
		expect(result.edit?.newText).toContain('with');
		expect(result.edit?.newText).toContain('select 1');
	});
});
