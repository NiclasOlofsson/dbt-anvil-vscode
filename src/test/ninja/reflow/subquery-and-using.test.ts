import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';

const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('reflow.subquery-and-using', () => {
	it('indents a subquery body inside WHERE IN (...)', async () => {
		const sql = 'select 1 from t where x in (select y from u)';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg());
		const rendered = result.edit?.newText ?? '';
		// Subquery body should be on its own indented line.
		expect(rendered).toMatch(/\(\n\s+select y/);
	});

	it('breaks USING predicate chains like ON', async () => {
		// Multi-column USING is uncommon but should wrap identically to ON.
		const sql = 'select 1 from t join u using (a) and 1=1';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg());
		const rendered = result.edit?.newText ?? '';
		// USING on its own indented line when the join has a chained predicate.
		expect(rendered).toMatch(/\n\s+using \(a\)/);
	});
});
