import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

/**
 * Tests for config-driven indent flags: indented_on, indented_then,
 * indented_joins. These are one-shot extra indents the printer applies
 * on the single line introduced by the trigger keyword.
 */
describe('reflow.indent-policy', () => {
	describe('indented_on (default: true)', () => {
		it('keeps ON flush with JOIN for a single-predicate join', () => {
			// Smart-break: `on t.a = u.a` has no AND/OR chain, so breaking
			// it onto its own line is wasteful — we keep it inline.
			const sql = 'select 1 from t join u on t.a = u.a';
			const doc = mockDocument(sql);
			const tokens = [
				sqlTok('SELECT', 0, 5, 0, 6),
				sqlTok('NUMBER', 7, 7, 0, 8),
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
			const ast: AstPayload[] = [
				{ c: 'Select', m: { start: 0, end: 34 } },
				{ c: 'From', i: 0, m: { start: 9, end: 34 } },
				{ c: 'Join', i: 1, m: { start: 16, end: 34 } },
			];
			const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg());
			const rendered = result.edit?.newText ?? '';
			// `join u on t.a = u.a` all on one line.
			expect(rendered).toContain('join u on t.a = u.a');
		});

		it('breaks ON onto its own indented line when the predicate has AND/OR', () => {
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
			const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg());
			const rendered = result.edit?.newText ?? '';
			// ON leads a new indented line when the predicate is a chain.
			expect(rendered).toMatch(/\n\s+on t\.a = u\.a/);
		});

		it('keeps ON flush with JOIN when policy is false', () => {
			const sql = 'select 1 from t join u on t.a = u.a';
			const doc = mockDocument(sql);
			const tokens = [
				sqlTok('SELECT', 0, 5, 0, 6),
				sqlTok('NUMBER', 7, 7, 0, 8),
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
			const ast: AstPayload[] = [
				{ c: 'Select', m: { start: 0, end: 34 } },
				{ c: 'From', i: 0, m: { start: 9, end: 34 } },
				{ c: 'Join', i: 1, m: { start: 16, end: 34 } },
			];
			const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
				indentation: { indentedOn: false },
			}));
			// `join u on ...` all on one line.
			expect(result.edit?.newText).toContain('join u on t.a = u.a');
		});
	});

	describe('indented_joins (default: false)', () => {
		it('indents JOIN one level when policy is true', () => {
			const sql = 'select 1 from t join u on t.a = u.a';
			const doc = mockDocument(sql);
			const tokens = [
				sqlTok('SELECT', 0, 5, 0, 6),
				sqlTok('NUMBER', 7, 7, 0, 8),
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
			const ast: AstPayload[] = [
				{ c: 'Select', m: { start: 0, end: 34 } },
				{ c: 'From', i: 0, m: { start: 9, end: 34 } },
				{ c: 'Join', i: 1, m: { start: 16, end: 34 } },
			];
			const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
				indentation: { indentedJoins: true, indentedOn: false },
			}));
			// JOIN line starts with 4 spaces (one indent level).
			expect(result.edit?.newText).toMatch(/\n\s{4}join u/);
		});
	});
});
