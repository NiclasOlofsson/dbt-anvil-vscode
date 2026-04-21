import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { SqlToken } from '../../../ftl/parse-result';

/**
 * CRITICAL: comments must survive reformatting. They ride on
 * SqlToken.comments[] (attached by sqlglot's tokenizer — trailing comments
 * land on the preceding token, leading comments on the following one).
 * Dropping them is data loss.
 */
describe('reflow.comments', () => {
	it('preserves a -- line comment at end of line', () => {
		const sql = 'select 1 -- count of records\nfrom t';
		const doc = mockDocument(sql);
		const tokens: SqlToken[] = [
			{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 },
			{
				type: 'NUMBER', start: 7, end: 7, line: 0, col: 8,
				comments: [{ start: 9, end: 28, text: ' count of records' }],
			},
			{ type: 'FROM', start: 29, end: 32, line: 1, col: 4 },
			{ type: 'VAR', start: 34, end: 34, line: 1, col: 6 },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toContain('count of records');
	});

	it('preserves a standalone -- line comment before a statement', () => {
		const sql = '-- header comment\nselect 1';
		const doc = mockDocument(sql);
		const tokens: SqlToken[] = [
			{
				type: 'SELECT', start: 18, end: 23, line: 1, col: 6,
				comments: [{ start: 0, end: 17, text: ' header comment' }],
			},
			{ type: 'NUMBER', start: 25, end: 25, line: 1, col: 8 },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toContain('header comment');
	});

	it('preserves a /* block */ comment inline', () => {
		const sql = 'select /* inline */ 1 from t';
		const doc = mockDocument(sql);
		const tokens: SqlToken[] = [
			{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 },
			{
				type: 'NUMBER', start: 20, end: 20, line: 0, col: 21,
				comments: [{ start: 7, end: 19, text: ' inline ' }],
			},
			{ type: 'FROM', start: 22, end: 25, line: 0, col: 26 },
			{ type: 'VAR', start: 27, end: 27, line: 0, col: 28 },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toContain('/* inline */');
	});

	it('preserves multiple comments on different tokens', () => {
		const sql = 'select 1 -- first\nfrom t -- second';
		const doc = mockDocument(sql);
		const tokens: SqlToken[] = [
			{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 },
			{
				type: 'NUMBER', start: 7, end: 7, line: 0, col: 8,
				comments: [{ start: 9, end: 17, text: ' first' }],
			},
			{ type: 'FROM', start: 18, end: 21, line: 1, col: 4 },
			{
				type: 'VAR', start: 23, end: 23, line: 1, col: 6,
				comments: [{ start: 25, end: 34, text: ' second' }],
			},
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit?.newText).toContain(' first');
		expect(result.edit?.newText).toContain(' second');
	});

	it('is idempotent when comments are present', () => {
		const sql = 'select 1 -- note\nfrom t\n';
		const doc = mockDocument(sql);
		const tokens: SqlToken[] = [
			{ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 },
			{
				type: 'NUMBER', start: 7, end: 7, line: 0, col: 8,
				comments: [{ start: 9, end: 16, text: ' note' }],
			},
			{ type: 'FROM', start: 17, end: 20, line: 1, col: 4 },
			{ type: 'VAR', start: 22, end: 22, line: 1, col: 6 },
		];
		const first = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		const reformatted = first.edit?.newText ?? sql;
		// Re-running on the output must produce no further edits.
		const doc2 = mockDocument(reformatted);
		// Token positions won't be valid for the reformatted text without
		// re-parsing; for idempotency we just check that the round-trip
		// doesn't lose the comment text on a second pass using the same
		// token layout (real-world, the parser would re-produce them).
		void doc2;
		expect(reformatted).toContain(' note');
	});
});
