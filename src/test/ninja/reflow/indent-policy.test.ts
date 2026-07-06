import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';

/**
 * Tests for config-driven indent flags: indented_on, indented_then,
 * indented_joins. These are one-shot extra indents the printer applies
 * on the single line introduced by the trigger keyword.
 */
const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('reflow.indent-policy', () => {
	describe('indented_on (default: true)', () => {
		it('keeps ON flush with JOIN for a single-predicate join', async () => {
			// Smart-break: `on t.a = u.a` has no AND/OR chain, so breaking
			// it onto its own line is wasteful — we keep it inline.
			const sql = 'select 1 from t join u on t.a = u.a';
			const doc = mockDocument(sql);
			const parsed = await parser.parse(sql);
			const result = reflowDocument(doc, parsed, cfg());
			const rendered = result.edit?.newText ?? '';
			// `join u on t.a = u.a` all on one line.
			expect(rendered).toContain('join u on t.a = u.a');
		});

		it('breaks ON onto its own indented line when the predicate has AND/OR', async () => {
			const sql = 'select 1 from t join u on t.a = u.a and t.b = u.b';
			const doc = mockDocument(sql);
			const parsed = await parser.parse(sql);
			const result = reflowDocument(doc, parsed, cfg());
			const rendered = result.edit?.newText ?? '';
			// ON leads a new indented line when the predicate is a chain.
			expect(rendered).toMatch(/\n\s+on t\.a = u\.a/);
		});

		it('keeps ON flush with JOIN when policy is false', async () => {
			const sql = 'select 1 from t join u on t.a = u.a';
			const doc = mockDocument(sql);
			const parsed = await parser.parse(sql);
			const result = reflowDocument(doc, parsed, cfg({
				indentation: { indentedOn: false },
			}));
			// `join u on ...` all on one line.
			expect(result.edit?.newText).toContain('join u on t.a = u.a');
		});
	});

	describe('indented_joins (default: false)', () => {
		it('indents JOIN one level when policy is true', async () => {
			const sql = 'select 1 from t join u on t.a = u.a';
			const doc = mockDocument(sql);
			const parsed = await parser.parse(sql);
			const result = reflowDocument(doc, parsed, cfg({
				indentation: { indentedJoins: true, indentedOn: false },
			}));
			// JOIN line starts with 4 spaces (one indent level).
			expect(result.edit?.newText).toMatch(/\n\s{4}join u/);
		});
	});
});
