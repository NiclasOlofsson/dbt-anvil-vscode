import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { AstPayload } from '../../../ftl/parse-result';

/**
 * commaPosition: 'leading' — commas lead the continuation line rather
 * than trailing the previous one.
 */
describe('reflow.leading-comma', () => {
	it('emits SELECT-list comma as leading when wrapping', () => {
		// The only way wrapping fires in the current printer is when the
		// line would be "too long" per maxLineLength OR when we force a
		// wrap via config. Use a long enough SELECT list that wrapping
		// kicks in under maxLineLength: 20.
		const sql = 'select aaaa, bbbb, cccc from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 10, 0, 11),
			sqlTok('COMMA', 11, 11, 0, 12),
			sqlTok('VAR', 13, 16, 0, 17),
			sqlTok('COMMA', 17, 17, 0, 18),
			sqlTok('VAR', 19, 22, 0, 23),
			sqlTok('FROM', 24, 27, 0, 28),
			sqlTok('VAR', 29, 29, 0, 30),
		];
		const ast: AstPayload[] = [
			{ c: 'Select', m: { start: 0, end: 29 } },
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens, ast }), cfg({
			maxLineLength: 20,
			layout: { operatorPosition: 'leading', commaPosition: 'leading' },
		}));
		const rendered = result.edit?.newText ?? '';
		// Leading comma: the line after `aaaa` starts with `, bbbb`.
		expect(rendered).toMatch(/aaaa\n\s*, bbbb/);
	});
});
