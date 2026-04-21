import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok } from '../helpers';
import type { DialectSymbols } from '../../../ftl/sql-parser';

/**
 * Function and type capitalisation must use the authoritative
 * DialectSymbols sets — NOT hardcoded heuristics. The printer accepts
 * dialect symbols as an optional input; when present it uses them for
 * function and type recasing.
 */
describe('reflow.dialect-cap', () => {
	const symbols: DialectSymbols = {
		functions: new Set(['count', 'coalesce', 'lower', 'upper', 'nullif', 'cast']),
		keywordTokenTypes: new Set(['select', 'from', 'where']),
		types: new Set(['int', 'varchar', 'bigint', 'timestamp']),
	};

	it('uppercases function names when functions policy is upper', () => {
		// `count(*)` → `COUNT(*)`
		const sql = 'select count(*) from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 11, 0, 12), // count
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('STAR', 13, 13, 0, 14),
			sqlTok('R_PAREN', 14, 14, 0, 15),
			sqlTok('FROM', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'lower', functions: 'upper', literals: 'lower', types: 'lower' },
		}), symbols);
		expect(result.edit?.newText).toContain('COUNT(*)');
	});

	it('does not recase an identifier that happens to share spelling with a function', () => {
		// `count` used as a column alias — must stay as-is.
		const sql = 'select a.count from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8), // a
			sqlTok('DOT', 8, 8, 0, 9),
			sqlTok('VAR', 9, 13, 0, 14), // count (as identifier, not called)
			sqlTok('FROM', 15, 18, 0, 19),
			sqlTok('VAR', 20, 20, 0, 21),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'lower', functions: 'upper', literals: 'lower', types: 'lower' },
		}), symbols);
		// `a.count` not followed by `(` — treat as identifier, leave alone.
		expect(result.edit?.newText).toContain('a.count');
		expect(result.edit?.newText).not.toContain('COUNT');
	});

	it('uppercases type names when types policy is upper', () => {
		// `cast(x as varchar)` → `cast(x AS VARCHAR)` (cast is function, AS is keyword, varchar is type)
		const sql = 'select cast(x as varchar) from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 10, 0, 11), // cast
			sqlTok('L_PAREN', 11, 11, 0, 12),
			sqlTok('VAR', 12, 12, 0, 13), // x
			sqlTok('ALIAS', 14, 15, 0, 16), // as
			sqlTok('VAR', 17, 23, 0, 24), // varchar
			sqlTok('R_PAREN', 24, 24, 0, 25),
			sqlTok('FROM', 26, 29, 0, 30),
			sqlTok('VAR', 31, 31, 0, 32),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'lower', functions: 'lower', literals: 'lower', types: 'upper' },
		}), symbols);
		expect(result.edit?.newText).toContain('VARCHAR');
	});

	it('uses dialect keywordTokenTypes instead of hardcoded set', () => {
		// Set contains 'qualify' which isn't in the hardcoded fallback for
		// every dialect. With symbols supplied, it should recase.
		const localSymbols: DialectSymbols = {
			functions: new Set(),
			keywordTokenTypes: new Set(['qualify']),
			types: new Set(),
		};
		const sql = 'QUALIFY 1';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('QUALIFY', 0, 6, 0, 7),
			sqlTok('NUMBER', 8, 8, 0, 9),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'lower', functions: 'lower', literals: 'lower', types: 'lower' },
		}), localSymbols);
		expect(result.edit?.newText?.trim()).toBe('qualify 1');
	});
});
