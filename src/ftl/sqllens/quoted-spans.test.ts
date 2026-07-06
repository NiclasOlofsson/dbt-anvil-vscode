import { describe, expect, it } from 'vitest';
import { SqllensDocumentParser } from './document-parser';
import type { ColumnRefToken, TableRefToken } from '../../services/parse-service';

function parser(adapterType: string) {
	return new SqllensDocumentParser({ adapterType });
}

/**
 * Quoted-identifier span contract: for ANY quoted identifier, every span
 * (col inclusive start, endCol exclusive end, 0-based line) covers the WHOLE
 * raw source token INCLUDING its delimiters. Name STRINGS keep whatever
 * `normName` produces for the dialect — only the SPAN is pinned here.
 */
describe('quoted-identifier spans — extract-boundary contract', () => {
	it('databricks: backtick-quoted column_ref covers the whole raw token', async () => {
		const sql = 'select `My Col` from t';
		const raw = '`My Col`';
		const q = sql.indexOf(raw);
		const model = await parser('databricks').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'my col', // databricks lowercases even a quoted name
		)!;
		expect(col).toBeDefined();
		expect(col.line).toBe(0);
		expect(col.col).toBe(q); // whole token, INCLUDING the opening backtick
		expect(col.endCol).toBe(q + raw.length);
	});

	it('databricks: backtick-quoted column_ref with an unquoted qualifier — both spans exact', async () => {
		const sql = 'select o.`My Col` from orders o';
		const raw = '`My Col`';
		const q = sql.indexOf(raw);
		const model = await parser('databricks').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'my col',
		)!;
		expect(col.col).toBe(q);
		expect(col.endCol).toBe(q + raw.length);

		// The unquoted qualifier `o` — token-width based (identity case).
		expect(col.table).toBe('o');
		expect(col.tableLine).toBe(0);
		expect(col.tableCol).toBe(sql.indexOf('o.'));
		expect(col.tableEndCol).toBe(sql.indexOf('o.') + 1);
	});

	it('snowflake: double-quoted column_ref covers the whole raw token', async () => {
		const sql = 'select "My Col" from t';
		const raw = '"My Col"';
		const q = sql.indexOf(raw);
		const model = await parser('snowflake').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'My Col', // snowflake preserves quoted case
		)!;
		expect(col).toBeDefined();
		expect(col.line).toBe(0);
		expect(col.col).toBe(q); // whole token, INCLUDING the opening double quote
		expect(col.endCol).toBe(q + raw.length);
	});

	it('postgres: double-quoted column_ref covers the whole raw token', async () => {
		const sql = 'select "My Col" from t';
		const raw = '"My Col"';
		const q = sql.indexOf(raw);
		const model = await parser('postgres').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'My Col', // postgres preserves quoted case too
		)!;
		expect(col).toBeDefined();
		expect(col.line).toBe(0);
		expect(col.col).toBe(q); // whole token, INCLUDING the opening double quote
		expect(col.endCol).toBe(q + raw.length);
	});

	it('snowflake: double-quoted table alias covers the whole raw token', async () => {
		// `addAlias` computes `aliasEndCol = column + alias.length`. Unlike a column
		// NAME (delimiter-stripped by the IR for double quotes, per `quotedRaw`), a
		// table_ref's `alias` string arrives with its quotes intact, so the arithmetic
		// lands on the whole raw token.
		const sql = 'select 1 as x from tbl "My Alias"';
		const raw = '"My Alias"';
		const q = sql.indexOf(raw);
		const model = await parser('snowflake').parse(sql);
		const ref = model.tokens.find(
			(t): t is TableRefToken => t.type === 'table_ref' && t.name === 'TBL',
		)!;
		expect(ref).toBeDefined();
		expect(ref.alias).toBe(raw); // delimiters intact in the IR alias string
		expect(ref.aliasLine).toBe(0);
		expect(ref.aliasCol).toBe(q);
		expect(ref.aliasEndCol).toBe(q + raw.length);
	});

	it('snowflake: double-quoted CTE name — definition token, FROM-reference token, and CteInfo all cover the raw token', async () => {
		// The CTE-definition token emission computes `endCol: s.column + rawName.length`
		// where `rawName` is `cteRef.def.name`. For a WITH-clause CTE name the IR's
		// `.name` string is NOT delimiter-stripped (unlike a Column/Table name part),
		// so `rawName.length` equals the raw token's width and the span covers the
		// whole token.
		const sql = 'with "My Cte" as (select 1 as a) select * from "My Cte"';
		const raw = '"My Cte"';
		const defQ = sql.indexOf(raw);
		const refQ = sql.indexOf(raw, defQ + 1);
		const model = await parser('snowflake').parse(sql);

		const defTok = model.tokens.find(
			(t): t is TableRefToken => t.type === 'table_ref' && t.cteDefinition === true,
		)!;
		expect(defTok).toBeDefined();
		expect(defTok.line).toBe(0);
		expect(defTok.col).toBe(defQ);
		expect(defTok.endCol).toBe(defQ + raw.length);

		// The FROM-clause reference token resolves off the actual lexer token text
		// (not the IR name string), so its span is token-width by construction.
		const refTok = model.tokens.find(
			(t): t is TableRefToken => t.type === 'table_ref' && !t.cteDefinition,
		)!;
		expect(refTok).toBeDefined();
		expect(refTok.col).toBe(refQ);
		expect(refTok.endCol).toBe(refQ + raw.length);

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
