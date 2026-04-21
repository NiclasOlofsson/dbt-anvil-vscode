import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

/**
 * Tests for multi-condition predicate wrapping. AND/OR inside Where,
 * Having, or Join ON clauses break to their own line driven by
 * config.layout.operatorPosition.
 */
describe('reflow.predicate-layout', () => {
	it('breaks before AND in WHERE when operator position is leading', () => {
		// where a = 1 and b = 2
		const sql = 'select 1 from t where a = 1 and b = 2';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('WHERE', 16, 20, 0, 21),
			sqlTok('VAR', 22, 22, 0, 23),
			sqlTok('EQ', 24, 24, 0, 25),
			sqlTok('NUMBER', 26, 26, 0, 27),
			sqlTok('AND', 28, 30, 0, 31),
			sqlTok('VAR', 32, 32, 0, 33),
			sqlTok('EQ', 34, 34, 0, 35),
			sqlTok('NUMBER', 36, 36, 0, 37),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 36 } },
			{ c: 'From', i: 0, m: { start: 9, end: 14 } },
			{ c: 'Where', i: 0, m: { start: 16, end: 36 } },
			{ c: 'And', i: 2, m: { start: 22, end: 36 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		// Expect `and b = 2` on its own indented line.
		expect(result.edit?.newText).toMatch(/where a = 1\n\s+and b = 2/);
	});

	it('breaks after AND in WHERE when operator position is trailing', () => {
		const sql = 'select 1 from t where a = 1 and b = 2';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('WHERE', 16, 20, 0, 21),
			sqlTok('VAR', 22, 22, 0, 23),
			sqlTok('EQ', 24, 24, 0, 25),
			sqlTok('NUMBER', 26, 26, 0, 27),
			sqlTok('AND', 28, 30, 0, 31),
			sqlTok('VAR', 32, 32, 0, 33),
			sqlTok('EQ', 34, 34, 0, 35),
			sqlTok('NUMBER', 36, 36, 0, 37),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 36 } },
			{ c: 'From', i: 0, m: { start: 9, end: 14 } },
			{ c: 'Where', i: 0, m: { start: 16, end: 36 } },
			{ c: 'And', i: 2, m: { start: 22, end: 36 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			layout: { operatorPosition: 'trailing', commaPosition: 'trailing' },
		}));
		// Expect `and` at end of line, `b = 2` on the next indented line.
		expect(result.edit?.newText).toMatch(/a = 1 and\n\s+b = 2/);
	});

	it('breaks before AND in JOIN ON when both indentedOn and leading are set', () => {
		// join u on t.a = u.a and t.b = u.b
		const sql = 'select 1 from t join u on t.a = u.a and t.b = u.b';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
			sqlTok('ON', 23, 24, 0, 25),
			sqlTok('VAR', 26, 26, 0, 27), sqlTok('DOT', 27, 27, 0, 28), sqlTok('VAR', 28, 28, 0, 29),
			sqlTok('EQ', 30, 30, 0, 31),
			sqlTok('VAR', 32, 32, 0, 33), sqlTok('DOT', 33, 33, 0, 34), sqlTok('VAR', 34, 34, 0, 35),
			sqlTok('AND', 36, 38, 0, 39),
			sqlTok('VAR', 40, 40, 0, 41), sqlTok('DOT', 41, 41, 0, 42), sqlTok('VAR', 42, 42, 0, 43),
			sqlTok('EQ', 44, 44, 0, 45),
			sqlTok('VAR', 46, 46, 0, 47), sqlTok('DOT', 47, 47, 0, 48), sqlTok('VAR', 48, 48, 0, 49),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 48 } },
			{ c: 'From', i: 0, m: { start: 9, end: 48 } },
			{ c: 'Join', i: 1, m: { start: 16, end: 48 } },
			{ c: 'And', i: 2, m: { start: 26, end: 48 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		const rendered = result.edit?.newText ?? '';
		// The ON predicate should chain across two indented lines.
		expect(rendered).toMatch(/\n\s+on t\.a = u\.a\n\s+and t\.b = u\.b/);
	});

	it('does NOT break AND inside a CASE WHEN body', () => {
		// select case when a > 0 and a < 10 then 'ok' end from t
		const sql = 'select case when a > 0 and a < 10 then \'ok\' end from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18),
			sqlTok('GT', 19, 19, 0, 20),
			sqlTok('NUMBER', 21, 21, 0, 22),
			sqlTok('AND', 23, 25, 0, 26),
			sqlTok('VAR', 27, 27, 0, 28),
			sqlTok('LT', 29, 29, 0, 30),
			sqlTok('NUMBER', 31, 32, 0, 33),
			sqlTok('THEN', 34, 37, 0, 38),
			sqlTok('STRING', 39, 42, 0, 43),
			sqlTok('END', 45, 47, 0, 48),
			sqlTok('FROM', 49, 52, 0, 53),
			sqlTok('VAR', 54, 54, 0, 55),
		];
		// AST: CASE is the ancestor at the AND offset. No Where/Having/Join
		// enclosure for this AND at all, so the predicate rule must not fire.
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 54 } },
			{ c: 'Case', i: 0, m: { start: 7, end: 47 } },
			{ c: 'If', i: 1, m: { start: 12, end: 43 } },
			{ c: 'And', i: 2, m: { start: 17, end: 32 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
			indentation: { indentedThen: false },
		}));
		const rendered = result.edit?.newText ?? '';
		// `a > 0 and a < 10` stays together on one line inside the CASE.
		expect(rendered).toMatch(/a > 0 and a < 10/);
	});
});
