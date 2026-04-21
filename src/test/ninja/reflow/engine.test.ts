import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { JinjaToken } from '../../../ftl/jinja-tokenizer';

describe('reflow.engine — initial scaffold', () => {
	it('returns no edit when model is undefined', () => {
		const doc = mockDocument('select 1');
		const result = reflowDocument(doc, undefined, cfg());
		expect(result.edit).toBeNull();
		expect(result.reason).toMatch(/no parsed model/i);
	});

	it('returns no edit when the token stream is empty', () => {
		const doc = mockDocument('');
		const result = reflowDocument(doc, model(), cfg());
		expect(result.edit).toBeNull();
		expect(result.reason).toMatch(/no tokens/i);
	});

	it('is idempotent: re-running on already-formatted SQL is a no-op', () => {
		const sql = 'select 1\n';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg());
		expect(result.edit).toBeNull();
		expect(result.reason).toMatch(/already matches/i);
	});

	it('preserves jinja tokens verbatim', () => {
		const sql = 'select {{ ref("x") }}';
		const doc = mockDocument(sql);
		const sqlTokens = [sqlTok('SELECT', 0, 5, 0, 6)];
		const jinjaTokens: JinjaToken[] = [{
			type: 'jinja_expression_open',
			value: '{{',
			start: 7,
			end: 8,
			line: 0,
			col: 7,
			tagEnd: 21,
		}];
		const result = reflowDocument(doc, model({ sqlTokens, jinjaTokens }), cfg());
		// The jinja span must survive byte-identically regardless of
		// surrounding whitespace changes.
		const rendered = result.edit ? result.edit.newText : sql;
		expect(rendered).toContain('{{ ref("x") }}');
	});
});
