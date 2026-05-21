import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

/**
 * maxLineLength wrapping: a SELECT list with multiple targets always wraps
 * under the LT09 (layout.select-targets) prescription — each target on its
 * own line — and additionally wraps when the projected single-line width
 * exceeds maxLineLength. A single-target SELECT stays inline unless it
 * overflows.
 */
describe('reflow.line-length', () => {
	it('keeps a single-target SELECT inline when it fits', () => {
		const sql = 'select a from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 14 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			maxLineLength: 120,
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		// Single target → SELECT keyword and the target stay on one line.
		expect(result.edit?.newText).toContain('select a');
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
		// Expect each target on its own line when the list doesn't fit —
		// SELECT keyword alone on a line, every target indented under it.
		// This is the dbt-labs/sqlfmt convention and keeps the wrap shape
		// uniform regardless of which target triggers the overflow.
		expect(rendered).toMatch(/select\n\s+aaaaa,\n\s+bbbbb,/);
	});
});
