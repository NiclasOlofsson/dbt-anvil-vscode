import { describe, expect, it } from 'vitest';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { nameRangeOf, qualifierRangeOf, rangeOfSpan } from '../../../providers/sql/sym-spans';

function parser(adapterType: string) {
	return new SqllensDocumentParser({ adapterType });
}

/**
 * Quoted-identifier span contract: for ANY quoted identifier, every span
 * (col inclusive start, endCol exclusive end, 0-based line) covers the WHOLE
 * raw source token INCLUDING its delimiters. `Sym.name` (sqllens's
 * `displayName`) strips the delimiters but never changes case, regardless of
 * dialect — only the SPAN is pinned here, not the name string.
 */
describe('quoted-identifier spans — extract-boundary contract', () => {
	it('databricks: backtick-quoted column covers the whole raw token', async () => {
		const sql = 'select `My Col` from t';
		const raw = '`My Col`';
		const q = sql.indexOf(raw);
		const model = await parser('databricks').parse(sql);
		const col = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'My Col')!;
		expect(col).toBeDefined();
		const range = nameRangeOf(col);
		expect(range.start.line).toBe(0);
		expect(range.start.character).toBe(q); // whole token, INCLUDING the opening backtick
		expect(range.end.character).toBe(q + raw.length);
	});

	it('databricks: backtick-quoted column with an unquoted qualifier — both spans exact', async () => {
		const sql = 'select o.`My Col` from orders o';
		const raw = '`My Col`';
		const q = sql.indexOf(raw);
		const model = await parser('databricks').parse(sql);
		const col = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name.split('.').pop() === 'My Col')!;
		const range = nameRangeOf(col);
		expect(range.start.character).toBe(q);
		expect(range.end.character).toBe(q + raw.length);

		// The unquoted qualifier `o` — token-width based (identity case), resolved
		// to the `orders o` relation via Sym.source (never by name).
		const qualRange = qualifierRangeOf(col)!;
		expect(qualRange.start.character).toBe(sql.indexOf('o.'));
		expect(qualRange.end.character).toBe(sql.indexOf('o.') + 1);
		const relation = col.source;
		expect(relation?.alias?.name).toBe('o');
	});

	it('snowflake: double-quoted column covers the whole raw token', async () => {
		const sql = 'select "My Col" from t';
		const raw = '"My Col"';
		const q = sql.indexOf(raw);
		const model = await parser('snowflake').parse(sql);
		const col = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'My Col')!; // snowflake preserves quoted case
		expect(col).toBeDefined();
		const range = nameRangeOf(col);
		expect(range.start.line).toBe(0);
		expect(range.start.character).toBe(q); // whole token, INCLUDING the opening double quote
		expect(range.end.character).toBe(q + raw.length);
	});

	it('postgres: double-quoted column covers the whole raw token', async () => {
		const sql = 'select "My Col" from t';
		const raw = '"My Col"';
		const q = sql.indexOf(raw);
		const model = await parser('postgres').parse(sql);
		const col = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'My Col')!; // postgres preserves quoted case too
		expect(col).toBeDefined();
		const range = nameRangeOf(col);
		expect(range.start.line).toBe(0);
		expect(range.start.character).toBe(q); // whole token, INCLUDING the opening double quote
		expect(range.end.character).toBe(q + raw.length);
	});

	it('snowflake: double-quoted table alias covers the whole raw token', async () => {
		// Sym.alias.name (sqllens's displayName) strips the quoting delimiters —
		// unlike the retired TokenInfo bridge's alias string, which kept them intact.
		// The alias Sym's own SPAN still covers the whole raw token, quotes included.
		const sql = 'select 1 as x from tbl "My Alias"';
		const raw = '"My Alias"';
		const q = sql.indexOf(raw);
		const model = await parser('snowflake').parse(sql);
		// Sym.name is never dialect-folded (unlike model.finalColumns/model.ctes) — the
		// unquoted table name 'tbl' keeps its declared (lowercase) spelling here.
		const tableSym = (model.symbols ?? []).find(s => s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'tbl')!;
		expect(tableSym).toBeDefined();
		const alias = tableSym.alias;
		expect(alias).toBeDefined();
		expect(alias!.name).toBe('My Alias'); // delimiters stripped, case preserved
		const aliasRange = rangeOfSpan(alias!.span);
		expect(aliasRange.start.line).toBe(0);
		expect(aliasRange.start.character).toBe(q); // whole token, INCLUDING the opening quote
		expect(aliasRange.end.character).toBe(q + raw.length);
	});

	it('snowflake: double-quoted CTE name — declaration start, reference span, and CteInfo all anchor at the raw token', async () => {
		// The declaration Sym's own span covers the WHOLE "name AS (body)" clause
		// (relationNameRangeOf's narrowing territory) — but narrowing via
		// Sym.name.length would undershoot for a quoted name (delimiters stripped),
		// so only the declaration's START position is asserted here, which is exact
		// regardless of quoting (the name always starts the clause).
		const sql = 'with "My Cte" as (select 1 as a) select * from "My Cte"';
		const raw = '"My Cte"';
		const defQ = sql.indexOf(raw);
		const refQ = sql.indexOf(raw, defQ + 1);
		const model = await parser('snowflake').parse(sql);

		const defSym = (model.symbols ?? []).find(s => s.kind === 'cte' && s.modifiers.includes('declaration'))!;
		expect(defSym).toBeDefined();
		expect(defSym.span.line - 1).toBe(0);
		expect(defSym.span.column).toBe(defQ);

		// The reference has no alias, so its span is already name-only (unwidened) —
		// a raw quoted token, no narrowing needed or attempted.
		const refSym = (model.symbols ?? []).find(s => s.kind === 'cte' && s.modifiers.includes('reference'))!;
		expect(refSym).toBeDefined();
		const refRange = rangeOfSpan(refSym.span);
		expect(refRange.start.character).toBe(refQ);
		expect(refRange.end.character).toBe(refQ + raw.length);

		// CteInfo.col is the name-token start. CteInfo.endCol anchors the CLOSING
		// PAREN of the CTE body (see parse-service.ts CteInfo doc comment and
		// ctes.ts's header), NOT the name span — a different concept entirely.
		const cte = model.ctes.find(c => c.name === 'My Cte')!;
		expect(cte).toBeDefined();
		expect(cte.col).toBe(defQ);
		const closeParen = sql.indexOf(')', defQ);
		expect(cte.endCol).toBe(closeParen + 1);
	});
});
