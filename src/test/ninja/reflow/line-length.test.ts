import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';

/**
 * maxLineLength wrapping: a SELECT list with multiple targets always wraps
 * under the LT09 (layout.select-targets) prescription — each target on its
 * own line — and additionally wraps when the projected single-line width
 * exceeds maxLineLength. A single-target SELECT stays inline unless it
 * overflows.
 */
const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('reflow.line-length', () => {
	it('keeps a single-target SELECT inline when it fits', async () => {
		const sql = 'select a from t';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg({
			maxLineLength: 120,
			layout: { operatorPosition: 'leading', commaPosition: 'trailing' },
		}));
		// Single target → SELECT keyword and the target stay on one line.
		expect(result.edit?.newText).toContain('select a');
	});

	it('wraps SELECT list onto multiple lines when it would exceed maxLineLength', async () => {
		// Build a SELECT with enough columns that the line exceeds 40 chars.
		const sql = 'select aaaaa, bbbbb, ccccc, ddddd, eeeee from t';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg({
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
