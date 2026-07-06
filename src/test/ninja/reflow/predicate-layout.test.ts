import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';

/**
 * Tests for multi-condition predicate wrapping. AND/OR inside Where,
 * Having, or Join ON clauses break to their own line driven by
 * config.layout.operatorPosition.
 */
const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('reflow.predicate-layout', () => {
	it('breaks before AND in WHERE when operator position is leading', async () => {
		// where a = 1 and b = 2
		const sql = 'select 1 from t where a = 1 and b = 2';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg({
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		// Expect `and b = 2` on its own indented line.
		expect(result.edit?.newText).toMatch(/where a = 1\n\s+and b = 2/);
	});

	it('breaks after AND in WHERE when operator position is trailing', async () => {
		const sql = 'select 1 from t where a = 1 and b = 2';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg({
			layout: { operatorPosition: 'trailing', commaPosition: 'trailing' },
		}));
		// Expect `and` at end of line, `b = 2` on the next indented line.
		expect(result.edit?.newText).toMatch(/a = 1 and\n\s+b = 2/);
	});

	it('breaks before AND in JOIN ON when both indentedOn and leading are set', async () => {
		// join u on t.a = u.a and t.b = u.b
		const sql = 'select 1 from t join u on t.a = u.a and t.b = u.b';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg({
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		const rendered = result.edit?.newText ?? '';
		// The ON predicate should chain across two indented lines.
		expect(rendered).toMatch(/\n\s+on t\.a = u\.a\n\s+and t\.b = u\.b/);
	});

	it('does NOT break AND inside a CASE WHEN body', async () => {
		// select case when a > 0 and a < 10 then 'ok' end from t
		const sql = 'select case when a > 0 and a < 10 then \'ok\' end from t';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg({
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
			indentation: { indentedThen: false },
		}));
		const rendered = result.edit?.newText ?? '';
		// `a > 0 and a < 10` stays together on one line inside the CASE.
		expect(rendered).toMatch(/a > 0 and a < 10/);
	});
});
