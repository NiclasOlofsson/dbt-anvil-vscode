import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

/**
 * maxLineLength wrapping: when a SELECT list would exceed the configured
 * line width, each target goes on its own line. Short SELECT lists stay
 * inline.
 */
describe('reflow.line-length', () => {
	it('keeps a short SELECT list inline when it fits', () => {
		const sql = 'select a, b from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('COMMA', 8, 8, 0, 9),
			sqlTok('VAR', 10, 10, 0, 11),
			sqlTok('FROM', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 17 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			maxLineLength: 120,
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		// `select a, b` all on one line.
		expect(result.edit?.newText).toContain('select a, b');
	});

	it('wraps SELECT list onto multiple lines when it would exceed maxLineLength', () => {
		// Build a SELECT with enough columns that the line exceeds 40 chars.
		const sql = 'select aaaaa, bbbbb, ccccc, ddddd, eeeee from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 11, 0, 12),
			sqlTok('COMMA', 12, 12, 0, 13),
			sqlTok('VAR', 14, 18, 0, 19),
			sqlTok('COMMA', 19, 19, 0, 20),
			sqlTok('VAR', 21, 25, 0, 26),
			sqlTok('COMMA', 26, 26, 0, 27),
			sqlTok('VAR', 28, 32, 0, 33),
			sqlTok('COMMA', 33, 33, 0, 34),
			sqlTok('VAR', 35, 39, 0, 40),
			sqlTok('FROM', 41, 44, 0, 45),
			sqlTok('VAR', 46, 46, 0, 47),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 46 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			maxLineLength: 40,
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		const rendered = result.edit?.newText ?? '';
		// Expect each target on its own line when the list doesn't fit.
		expect(rendered).toMatch(/select aaaaa,\n\s+bbbbb,/);
	});
});
