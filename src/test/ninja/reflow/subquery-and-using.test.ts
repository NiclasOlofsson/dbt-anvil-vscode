import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

describe('reflow.subquery-and-using', () => {
	it('indents a subquery body inside WHERE IN (...)', () => {
		const sql = 'select 1 from t where x in (select y from u)';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('WHERE', 16, 20, 0, 21),
			sqlTok('VAR', 22, 22, 0, 23),
			sqlTok('IN', 24, 25, 0, 26),
			sqlTok('L_PAREN', 27, 27, 0, 28),
			sqlTok('SELECT', 28, 33, 0, 34),
			sqlTok('VAR', 35, 35, 0, 36),
			sqlTok('FROM', 37, 40, 0, 41),
			sqlTok('VAR', 42, 42, 0, 43),
			sqlTok('R_PAREN', 43, 43, 0, 44),
		];
		// The L_PAREN at offset 27 opens a subquery — smallest enclosing
		// non-paren class is `Subquery`.
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 42 } },
			{ c: 'Where', i: 0, m: { start: 16, end: 42 } },
			{ c: 'In', i: 1, m: { start: 22, end: 42 } },
			{ c: 'Subquery', i: 2, m: { start: 27, end: 43 } },
			{ c: 'Select', i: 3, m: { start: 28, end: 42 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg());
		const rendered = result.edit?.newText ?? '';
		// Subquery body should be on its own indented line.
		expect(rendered).toMatch(/\(\n\s+select y/);
	});

	it('breaks USING predicate chains like ON', () => {
		// Multi-column USING is uncommon but should wrap identically to ON.
		const sql = 'select 1 from t join u using (a) and 1=1';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
			sqlTok('USING', 23, 27, 0, 28),
			sqlTok('L_PAREN', 29, 29, 0, 30),
			sqlTok('VAR', 30, 30, 0, 31),
			sqlTok('R_PAREN', 31, 31, 0, 32),
			sqlTok('AND', 33, 35, 0, 36),
			sqlTok('NUMBER', 37, 37, 0, 38),
			sqlTok('EQ', 38, 38, 0, 39),
			sqlTok('NUMBER', 39, 39, 0, 40),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 39 } },
			{ c: 'From', i: 0, m: { start: 9, end: 39 } },
			{ c: 'Join', i: 1, m: { start: 16, end: 39 } },
			{ c: 'And', i: 2, m: { start: 30, end: 39 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg());
		const rendered = result.edit?.newText ?? '';
		// USING on its own indented line when the join has a chained predicate.
		expect(rendered).toMatch(/\n\s+using \(a\)/);
	});
});
