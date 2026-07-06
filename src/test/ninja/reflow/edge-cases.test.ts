import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { DialectSymbols } from '../../../ftl/sql-tokens';

describe('reflow.edge-cases', () => {
	it('does not emit more than N consecutive blank lines (maxBlankLines)', () => {
		// The printer should never produce more than one blank line between
		// statements/clauses regardless of config — we regenerate whitespace,
		// so consecutive blanks are a bug, not input-driven.
		const sql = 'select 1;\n\n\n\n\nselect 2';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('SEMICOLON', 8, 8, 0, 9),
			sqlTok('SELECT', 14, 19, 5, 6),
			sqlTok('NUMBER', 21, 21, 5, 8),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		const rendered = result.edit?.newText ?? '';
		// Never more than 2 consecutive newlines (one blank line max).
		expect(rendered).not.toMatch(/\n\n\n/);
	});

	it('consistent function capitalisation — reuses first casing seen', () => {
		const symbols: DialectSymbols = {
			functions: new Set(['count']),
			keywordTokenTypes: new Set(['select', 'from']),
			types: new Set(),
		};
		// select Count(*), COUNT(x) from t — under consistent, the second
		// occurrence should match the first.
		const sql = 'select Count(*), COUNT(x) from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 11, 0, 12), // Count
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('STAR', 13, 13, 0, 14),
			sqlTok('R_PAREN', 14, 14, 0, 15),
			sqlTok('COMMA', 15, 15, 0, 16),
			sqlTok('VAR', 17, 21, 0, 22), // COUNT
			sqlTok('L_PAREN', 22, 22, 0, 23),
			sqlTok('VAR', 23, 23, 0, 24),
			sqlTok('R_PAREN', 24, 24, 0, 25),
			sqlTok('FROM', 26, 29, 0, 30),
			sqlTok('VAR', 31, 31, 0, 32),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'lower', functions: 'consistent', literals: 'lower', types: 'lower' },
		}), symbols);
		const rendered = result.edit?.newText ?? '';
		// First occurrence was `Count`, so the second must render as `Count` too.
		expect(rendered).toContain('Count(*)');
		expect(rendered).toContain('Count(x)');
		expect(rendered).not.toContain('COUNT(');
	});

	it('handles trailing and leading comments on the same token', () => {
		// A token with both a leading comment (before it) and a trailing
		// comment (after it). Both must survive.
		const sql = '-- leading\nselect 1 -- trailing\nfrom t';
		const doc = mockDocument(sql);
		const tokens = [
			{
				type: 'SELECT', start: 11, end: 16, line: 1, col: 6,
				comments: [{ start: 0, end: 10, text: ' leading' }],
			},
			{
				type: 'NUMBER', start: 18, end: 18, line: 1, col: 8,
				comments: [{ start: 20, end: 31, text: ' trailing' }],
			},
			{ type: 'FROM', start: 32, end: 35, line: 2, col: 4 },
			{ type: 'VAR', start: 37, end: 37, line: 2, col: 6 },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		const rendered = result.edit?.newText ?? '';
		expect(rendered).toContain('-- leading');
		expect(rendered).toContain('-- trailing');
	});

	it('keeps a comment with embedded jinja-like text from being double-emitted', () => {
		// `-- note {{ ref('x') }}` contains text the jinja tokenizer will
		// pick up. The printer must suppress that fake jinja token so the
		// comment is emitted only once.
		const sql = 'select 1 -- see {{ ref(\'x\') }}\nfrom t';
		const doc = mockDocument(sql);
		const tokens = [
			{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 },
			{
				type: 'NUMBER', start: 7, end: 7, line: 0, col: 8,
				comments: [{ start: 9, end: 30, text: ' see {{ ref(\'x\') }}' }],
			},
			{ type: 'FROM', start: 31, end: 34, line: 1, col: 4 },
			{ type: 'VAR', start: 36, end: 36, line: 1, col: 6 },
		];
		const jinjaTokens = [{
			type: 'jinja_expression_open' as const,
			value: '{{',
			start: 16,
			end: 17,
			line: 0,
			col: 16,
			tagEnd: 30,
		}];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, jinjaTokens }), cfg());
		const rendered = result.edit?.newText ?? '';
		// The comment must survive exactly once — no duplicated jinja text.
		const occurrences = (rendered.match(/{{ ref\('x'\) }}/g) ?? []).length;
		expect(occurrences).toBe(1);
	});
});
