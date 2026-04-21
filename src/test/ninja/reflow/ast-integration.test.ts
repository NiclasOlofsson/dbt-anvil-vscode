import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

/**
 * These tests exercise the byte-range AST index wired through from
 * ParseService.DocumentModel → reflowDocument → printDocument. Tokens +
 * AST are constructed by hand because unit tests don't boot Pyodide.
 *
 * The shape of `AstPayload` is what sqlglot's serde.dump emits:
 *   c = class name, m = position {start, end}, i = parent index
 */
describe('reflow.ast-integration', () => {
	it('indents the body of a CTE when L_PAREN opens under a Cte node', () => {
		// with x as (select 1)
		const sql = 'with x as (select 1)';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('WITH', 0, 3, 0, 4),
			sqlTok('VAR', 5, 5, 0, 6),
			sqlTok('ALIAS', 7, 8, 0, 9),
			sqlTok('L_PAREN', 10, 10, 0, 11),
			sqlTok('SELECT', 11, 16, 0, 17),
			sqlTok('NUMBER', 18, 18, 0, 19),
			sqlTok('R_PAREN', 19, 19, 0, 20),
		];
		// AST: the L_PAREN at offset 10 lives under a Cte node. sqlglot
		// emits `Cte` for each `name AS (body)` clause.
		const ast: AstPayload[] = [
			{ c: 'With', m: { start: 0, end: 19 } },
			{ c: 'Cte', i: 0, m: { start: 5, end: 19 } },
			{ c: 'Select', i: 1, m: { start: 11, end: 18 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg());
		// Expect: the body `select 1` lands on a new, indented line; the
		// close paren returns to the outer indent level.
		expect(result.edit?.newText).toBe('with x as (\n    select 1\n)\n');
	});

	it('breaks after the comma between two CTE definitions', () => {
		// with a as (select 1), b as (select 2) select 1
		// For compactness we just verify the CTE-separator comma gets a
		// newline after it — the test is about comma disambiguation, not
		// the surrounding SELECT.
		const sql = 'with a as (select 1), b as (select 2) select 1';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('WITH', 0, 3, 0, 4),
			sqlTok('VAR', 5, 5, 0, 6),
			sqlTok('ALIAS', 7, 8, 0, 9),
			sqlTok('L_PAREN', 10, 10, 0, 11),
			sqlTok('SELECT', 11, 16, 0, 17),
			sqlTok('NUMBER', 18, 18, 0, 19),
			sqlTok('R_PAREN', 19, 19, 0, 20),
			sqlTok('COMMA', 20, 20, 0, 21),
			sqlTok('VAR', 22, 22, 0, 23),
			sqlTok('ALIAS', 24, 25, 0, 26),
			sqlTok('L_PAREN', 27, 27, 0, 28),
			sqlTok('SELECT', 28, 33, 0, 34),
			sqlTok('NUMBER', 35, 35, 0, 36),
			sqlTok('R_PAREN', 36, 36, 0, 37),
			sqlTok('SELECT', 38, 43, 0, 44),
			sqlTok('NUMBER', 45, 45, 0, 46),
		];
		// The comma at byte 20 sits directly under `With` with no nested
		// Paren/Func/Subquery enclosure — so it's a CTE separator.
		const ast: AstPayload[] = [
			{ c: 'With', m: { start: 0, end: 36 } },
			{ c: 'Cte', i: 0, m: { start: 5, end: 19 } },
			{ c: 'Select', i: 1, m: { start: 11, end: 18 } },
			{ c: 'Cte', i: 0, m: { start: 22, end: 36 } },
			{ c: 'Select', i: 3, m: { start: 28, end: 35 } },
			{ c: 'Select', m: { start: 38, end: 45 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg());
		const rendered = result.edit?.newText ?? '';
		// Second CTE's name must start a new line after the separator comma.
		expect(rendered).toMatch(/\),\s*\n\s*b/);
	});

	it('does NOT break on commas inside a function call', () => {
		// select coalesce(a, b) from t — the comma at offset 19 is inside
		// a function call, not a SELECT-list / CTE list. It must not break.
		const sql = 'select coalesce(a, b) from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 14, 0, 15),
			sqlTok('L_PAREN', 15, 15, 0, 16),
			sqlTok('VAR', 16, 16, 0, 17),
			sqlTok('COMMA', 17, 17, 0, 18),
			sqlTok('VAR', 19, 19, 0, 20),
			sqlTok('R_PAREN', 20, 20, 0, 21),
			sqlTok('FROM', 22, 25, 0, 26),
			sqlTok('VAR', 27, 27, 0, 28),
		];
		// The comma at 17 sits inside a Func → Paren. Smallest enclosing
		// non-list node is Func, which sits between Select and the comma,
		// so `isSelectListComma` must be false.
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 27 } },
			{ c: 'Func', i: 0, m: { start: 7, end: 20 } },
			{ c: 'Paren', i: 1, m: { start: 15, end: 20 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg());
		// Expect `coalesce(a, b)` intact on one line, NOT broken at the
		// function-args comma.
		expect(result.edit?.newText).toContain('coalesce(a, b)');
		expect(result.edit?.newText).not.toMatch(/coalesce\(a,\s*\n/);
	});

	it('falls back cleanly when AST is empty', () => {
		// Same SQL as the CTE test but with no AST — the printer must not
		// crash and must still produce valid output via token-stream
		// heuristics only. CTE body indentation won't fire, which is
		// expected — we just verify graceful degradation.
		const sql = 'with x as (select 1)';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('WITH', 0, 3, 0, 4),
			sqlTok('VAR', 5, 5, 0, 6),
			sqlTok('ALIAS', 7, 8, 0, 9),
			sqlTok('L_PAREN', 10, 10, 0, 11),
			sqlTok('SELECT', 11, 16, 0, 17),
			sqlTok('NUMBER', 18, 18, 0, 19),
			sqlTok('R_PAREN', 19, 19, 0, 20),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		// No crash, deterministic output.
		expect(result.edit?.newText).toBeDefined();
		expect(result.edit?.newText).toContain('with');
		expect(result.edit?.newText).toContain('select 1');
	});
});
