import { describe, it, expect } from 'vitest';
import { reflowDocument } from '../../../ninja/reflow/engine';
import { cfg, mockDocument, model, sqlTok, stubDialectSymbols } from '../helpers';

describe('reflow.capitalisation', () => {
	it('lowercases keywords when policy is lower', () => {
		const sql = 'SELECT 1 FROM t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'lower', functions: 'lower', literals: 'lower', types: 'lower' },
		}), stubDialectSymbols());
		expect(result.edit?.newText).toBe('select 1\nfrom t\n');
	});

	it('uppercases keywords when policy is upper', () => {
		const sql = 'select 1 from t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'upper', functions: 'upper', literals: 'upper', types: 'upper' },
		}), stubDialectSymbols());
		expect(result.edit?.newText).toBe('SELECT 1\nFROM t\n'); // identifier 't' stays lower
	});

	it('does not recase non-keyword identifiers when upper-casing keywords', () => {
		const sql = 'select MyCol from MyTable';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 11, 0, 12), // MyCol
			sqlTok('FROM', 13, 16, 0, 17),
			sqlTok('VAR', 18, 24, 0, 25), // MyTable
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'upper', functions: 'lower', literals: 'lower', types: 'lower' },
		}), stubDialectSymbols());
		// MyCol/MyTable preserved byte-identically; only the keywords recased.
		expect(result.edit?.newText).toBe('SELECT MyCol\nFROM MyTable\n');
	});

	it('recases literal keywords (NULL/TRUE/FALSE)', () => {
		const sql = 'select NULL';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NULL', 7, 10, 0, 11),
		];
		const result = reflowDocument(doc, model({ sqlTokens: tokens }), cfg({
			capitalisation: { keywords: 'lower', functions: 'lower', literals: 'lower', types: 'lower' },
		}), stubDialectSymbols());
		expect(result.edit?.newText).toBe('select null\n');
	});

	it('is idempotent: running twice produces the same output', () => {
		const sql = 'Select 1 From t';
		const doc = mockDocument(sql);
		const tokens = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		const c = cfg({ capitalisation: { keywords: 'lower', functions: 'lower', literals: 'lower', types: 'lower' } });
		const symbols = stubDialectSymbols();
		const first = reflowDocument(doc, model({ sqlTokens: tokens }), c, symbols);
		expect(first.edit?.newText).toBe('select 1\nfrom t\n');

		// Token positions shift after reflow — rebuild them against the new
		// text to simulate a re-parse.
		const reformatted = first.edit!.newText;
		const doc2 = mockDocument(reformatted);
		const tokens2 = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 1, 4),
			sqlTok('VAR', 14, 14, 1, 6),
		];
		const second = reflowDocument(doc2, model({ sqlTokens: tokens2 }), c, symbols);
		expect(second.edit).toBeNull();
	});
});
