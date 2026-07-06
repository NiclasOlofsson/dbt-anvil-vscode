import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { cfg, mockDocument } from '../helpers';

/**
 * commaPosition: 'leading' — commas lead the continuation line rather
 * than trailing the previous one.
 */
const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('reflow.leading-comma', () => {
	it('emits SELECT-list comma as leading when wrapping', async () => {
		// The only way wrapping fires in the current printer is when the
		// line would be "too long" per maxLineLength OR when we force a
		// wrap via config. Use a long enough SELECT list that wrapping
		// kicks in under maxLineLength: 20.
		const sql = 'select aaaa, bbbb, cccc from t';
		const doc = mockDocument(sql);
		const parsed = await parser.parse(sql);
		const result = reflowDocument(doc, parsed, cfg({
			maxLineLength: 20,
			layout: { operatorPosition: 'leading', commaPosition: 'leading' },
		}));
		const rendered = result.edit?.newText ?? '';
		// Leading comma: the line after `aaaa` starts with `, bbbb`.
		expect(rendered).toMatch(/aaaa\n\s*, bbbb/);
	});
});
