import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';

/**
 * Layout tests exercise the printer's structural decisions: newlines before
 * major clauses and joins, paren nesting, whitespace normalization.
 *
 * Token positions are constructed manually against the raw source because
 * we are not running FTL end-to-end in unit tests — the tokens only need
 * to reflect *types* and *byte spans* correctly; the printer does not
 * consult line/col for layout decisions.
 */
describe('reflow.layout', () => {
	it('breaks onto a new line before FROM', () => {
		const sql = 'select 1 from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toBe('select 1\nfrom t\n');
	});

	it('breaks before WHERE', () => {
		const sql = 'select a from t where a = 1';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('WHERE', 16, 20, 0, 21),
			sqlTok('VAR', 22, 22, 0, 23),
			sqlTok('EQ', 24, 24, 0, 25),
			sqlTok('NUMBER', 26, 26, 0, 27),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toBe('select a\nfrom t\nwhere a = 1\n');
	});

	it('breaks before JOIN', () => {
		const sql = 'select a from t join u on t.a = u.a';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
			sqlTok('ON', 23, 24, 0, 25),
			sqlTok('VAR', 26, 26, 0, 27),
			sqlTok('DOT', 27, 27, 0, 28),
			sqlTok('VAR', 28, 28, 0, 29),
			sqlTok('EQ', 30, 30, 0, 31),
			sqlTok('VAR', 32, 32, 0, 33),
			sqlTok('DOT', 33, 33, 0, 34),
			sqlTok('VAR', 34, 34, 0, 35),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		const lines = result.edit!.newText.split('\n');
		expect(lines).toContain('select a');
		expect(lines).toContain('from t');
		expect(lines.some(l => l.startsWith('join '))).toBe(true);
		// Qualified column names must stay tight: `t.a` not `t . a`.
		expect(result.edit!.newText).toContain('t.a');
		expect(result.edit!.newText).toContain('u.a');
	});

	it('keeps LEFT JOIN together on one line', () => {
		const sql = 'select 1 from t left join u on t.a = u.a';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('LEFT', 16, 19, 0, 20),
			sqlTok('JOIN', 21, 24, 0, 25),
			sqlTok('VAR', 26, 26, 0, 27),
			sqlTok('ON', 28, 29, 0, 30),
			sqlTok('VAR', 31, 31, 0, 32),
			sqlTok('DOT', 32, 32, 0, 33),
			sqlTok('VAR', 33, 33, 0, 34),
			sqlTok('EQ', 35, 35, 0, 36),
			sqlTok('VAR', 37, 37, 0, 38),
			sqlTok('DOT', 38, 38, 0, 39),
			sqlTok('VAR', 39, 39, 0, 40),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toContain('left join u');
	});

	it('normalizes multiple spaces to single space', () => {
		const sql = 'select     1     from     t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 11, 11, 0, 12),
			sqlTok('FROM', 17, 20, 0, 21),
			sqlTok('VAR', 26, 26, 0, 27),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toBe('select 1\nfrom t\n');
	});

	it('does not space around DOT', () => {
		const sql = 'select t.a from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('DOT', 8, 8, 0, 9),
			sqlTok('VAR', 9, 9, 0, 10),
			sqlTok('FROM', 11, 14, 0, 15),
			sqlTok('VAR', 16, 16, 0, 17),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toBe('select t.a\nfrom t\n');
	});

	it('does not space before comma', () => {
		const sql = 'select a,b from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('COMMA', 8, 8, 0, 9),
			sqlTok('VAR', 9, 9, 0, 10),
			sqlTok('FROM', 11, 14, 0, 15),
			sqlTok('VAR', 16, 16, 0, 17),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		// The multi-target SELECT wraps under the LT09 policy — `a` and `b`
		// each land on their own indented lines. The invariant under test is
		// "no space before the comma": `a,` must hug the identifier, and
		// `a ,` must never appear.
		expect(result.edit?.newText).toContain('a,');
		expect(result.edit?.newText).not.toContain('a ,');
	});

	it('breaks before UNION set operators', () => {
		const sql = 'select 1 union all select 2';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('ALL', 15, 17, 0, 18),
			sqlTok('SELECT', 19, 24, 0, 25),
			sqlTok('NUMBER', 26, 26, 0, 27),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		const lines = result.edit!.newText.split('\n').filter(l => l.length > 0);
		expect(lines[0]).toBe('select 1');
		expect(lines[1]).toBe('union all');
		expect(lines[2]).toBe('select 2');
	});

	it('adds a newline after semicolon', () => {
		const sql = 'select 1;select 2';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('SEMICOLON', 8, 8, 0, 9),
			sqlTok('SELECT', 9, 14, 0, 15),
			sqlTok('NUMBER', 16, 16, 0, 17),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toContain('select 1;\nselect 2');
	});
});
