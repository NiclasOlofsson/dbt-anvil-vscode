import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';

const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('reflow.cte-blank-line', () => {
	it('inserts a blank line between CTE definitions', async () => {
		// with a as (select 1), b as (select 2) select 1
		const sql = 'with a as (select 1), b as (select 2) select 1';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg());
		const rendered = result.edit?.newText ?? '';
		// After the first CTE's closing `),`, there should be a blank line
		// before the next CTE's name starts.
		expect(rendered).toMatch(/\),\n\s*\nb/);
	});
});
