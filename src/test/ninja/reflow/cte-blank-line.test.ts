import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

describe('reflow.cte-blank-line', () => {
	it('inserts a blank line between CTE definitions', () => {
		// with a as (select 1), b as (select 2) select 1
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
		// After the first CTE's closing `),`, there should be a blank line
		// before the next CTE's name starts.
		expect(rendered).toMatch(/\),\n\s*\nb/);
	});
});
