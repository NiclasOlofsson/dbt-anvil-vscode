import { describe, expect, it } from 'vitest';
import { tokenize } from 'sqllens';
import type { Dialect } from './api';
import { keywordTokenTypesFor, mapTokens } from './token-mapper';

function map(sql: string, dialect: Dialect = 'databricks') {
	return mapTokens(tokenize(sql, dialect), sql, dialect);
}

function types(sql: string, dialect: Dialect = 'databricks') {
	return map(sql, dialect).map(t => t.type);
}

describe('mapTokens — clause & compound naming', () => {
	// Column 6 vs the char count of "select": sqlglot's `col` is the 1-based
	// inclusive end column (= 0-based exclusive end), not the start column.
	const sql = 'select a, b\nfrom t\ngroup by a';

	it('emits sqlglot TokenType names and folds GROUP BY into one token', () => {
		expect(types(sql)).toEqual(['SELECT', 'VAR', 'COMMA', 'VAR', 'FROM', 'VAR', 'GROUP_BY', 'VAR']);
	});

	it('pins the offset/line/col convention on a first-line token', () => {
		// end is INCLUSIVE, line is 0-based, col is the exclusive end column.
		expect(map(sql)[0]).toMatchObject({ type: 'SELECT', start: 0, end: 5, line: 0, col: 6 });
	});

	it('pins the same convention on a later-line compound token', () => {
		const groupBy = map(sql).find(t => t.type === 'GROUP_BY')!;
		// "group by" spans offsets 19..26 on 0-based line 2, whose line start is 19.
		expect(groupBy).toMatchObject({ start: 19, end: 26, line: 2, col: 8 });
	});

	it('folds ORDER BY too and keeps STAR as its own token', () => {
		expect(types('select count(*)\nfrom t\norder by 1')).toEqual([
			'SELECT', 'VAR', 'L_PAREN', 'STAR', 'R_PAREN', 'FROM', 'VAR', 'ORDER_BY', 'NUMBER',
		]);
	});
});

describe('keywordTokenTypesFor', () => {
	// The union of the mapper's KEYWORDS/COMPOUNDS/DIALECT_* table VALUES — the
	// sqlglot TokenType NAMES a mapped token's `.type` can carry. UPPERCASE (matches
	// token.type); the document parser lowercases these into its DialectSymbols.
	it('unions base keyword + compound token-type names', () => {
		const s = keywordTokenTypesFor('databricks');
		expect(s.has('SELECT')).toBe(true);
		expect(s.has('GROUP_BY')).toBe(true); // from COMPOUNDS
		expect(s.has('ORDER_BY')).toBe(true);
		expect(s.has('ALIAS')).toBe(true); // AS -> ALIAS
		// VAR is an identifier fallback, never a keyword type.
		expect(s.has('VAR')).toBe(false);
	});

	it('folds in the dialect layer (tsql TOP)', () => {
		expect(keywordTokenTypesFor('tsql').has('TOP')).toBe(true);
		expect(keywordTokenTypesFor('databricks').has('TOP')).toBe(false);
	});

	it('caches — repeat calls return the identical set instance', () => {
		expect(keywordTokenTypesFor('snowflake')).toBe(keywordTokenTypesFor('snowflake'));
	});
});

describe('mapTokens — comment folding', () => {
	it('attaches a leading line comment to the following token, newline excluded', () => {
		// The ANTLR line-comment token swallows the "\n"; the fold must not.
		const toks = map('-- lead\nselect 1');
		expect(toks[0].type).toBe('SELECT');
		expect(toks[0].comments).toEqual([{ start: 0, end: 7, text: '-- lead' }]);
	});

	it('attaches a mid-stream block comment to the following token', () => {
		const toks = map('select /* x */ 1');
		const num = toks.find(t => t.type === 'NUMBER')!;
		expect(num.comments).toEqual([{ start: 7, end: 14, text: '/* x */' }]);
	});

	it('attaches a trailing end-of-file comment to the last token', () => {
		const toks = map('select 1\n-- bye');
		const last = toks[toks.length - 1];
		expect(last.type).toBe('NUMBER');
		expect(last.comments).toEqual([{ start: 9, end: 15, text: '-- bye' }]);
	});

	it('never surfaces comments as tokens', () => {
		expect(types('/* a */ select 1 -- b')).toEqual(['SELECT', 'NUMBER']);
	});
});

describe('mapTokens — whitespace never leaks (sqlglot emits no whitespace tokens)', () => {
	it('drops every whitespace/newline run across blank lines yet keeps comment attachment', () => {
		// Multi-line SQL with CRLF newlines and blank lines around a comment. sqlglot
		// emits NO whitespace tokens; a `\r\n`-typed leak was the top shadow-diff bucket.
		const sql = 'select a\r\n\r\n-- gap comment\r\n\r\nfrom t';
		const toks = map(sql);

		// No token is a whitespace run (pure-whitespace TEXT) nor a bare-newline TYPE.
		for (const t of toks) {
			expect(sql.slice(t.start, t.end + 1)).not.toMatch(/^\s+$/);
			expect(t.type).not.toMatch(/^\s+$/);
		}
		expect(toks.map(t => t.type)).toEqual(['SELECT', 'VAR', 'FROM', 'VAR']);

		// The comment sits before two blank lines and the FROM — it must still
		// attach to FROM (the whitespace between is dropped without breaking the fold).
		const from = toks.find(t => t.type === 'FROM')!;
		expect(from.comments?.map(c => c.text)).toEqual(['-- gap comment']);
	});
});

describe('mapTokens — CTE walk for debug-symbols buildCteRanges', () => {
	// buildCteRanges walks WITH → VAR(name) → ALIAS → L_PAREN … R_PAREN.
	const sql = 'with c as (select 1) select * from c';

	it('produces the WITH / VAR / ALIAS / L_PAREN opener with an R_PAREN close', () => {
		const toks = map(sql);
		expect(toks.slice(0, 4).map(t => t.type)).toEqual(['WITH', 'VAR', 'ALIAS', 'L_PAREN']);
		expect(sql.slice(toks[1].start, toks[1].end + 1)).toBe('c');
		expect(toks.some(t => t.type === 'R_PAREN')).toBe(true);
	});

	it('maps AS to ALIAS and an unquoted CTE name to VAR', () => {
		const toks = map(sql);
		expect(toks[1].type).toBe('VAR');
		expect(toks[2].type).toBe('ALIAS');
	});
});

describe('mapTokens — per-dialect', () => {
	it('tsql: bracket-quoted identifier → IDENTIFIER, GROUP BY folded', () => {
		const toks = map('select [a b], c from t group by c', 'tsql');
		expect(toks[1]).toMatchObject({ type: 'IDENTIFIER' });
		expect(toks.some(t => t.type === 'GROUP_BY')).toBe(true);
	});

	it('snowflake: double-quoted identifier → IDENTIFIER, unquoted → VAR', () => {
		const toks = map('select "A B", c from t', 'snowflake');
		expect(toks[1].type).toBe('IDENTIFIER');
		expect(toks[3].type).toBe('VAR');
	});

	it('databricks: backtick-quoted identifier → IDENTIFIER', () => {
		const toks = map('select `a b` from t', 'databricks');
		expect(toks[1].type).toBe('IDENTIFIER');
	});

	it('tsql: TOP is recognized as its own keyword', () => {
		expect(types('select top 10 x from t', 'tsql')).toEqual([
			'SELECT', 'TOP', 'NUMBER', 'VAR', 'FROM', 'VAR',
		]);
	});

	it('databricks: VOID is a dialect-specific type keyword', () => {
		expect(types('create table t (c void)', 'databricks')).toEqual([
			'CREATE', 'TABLE', 'VAR', 'L_PAREN', 'VAR', 'VOID', 'R_PAREN',
		]);
	});

	it('snowflake: WAREHOUSE is a dialect-specific keyword', () => {
		expect(types('use warehouse x', 'snowflake')).toEqual(['USE', 'WAREHOUSE', 'VAR']);
	});

	it('a base keyword (FROM) maps the same across all dialects', () => {
		for (const dialect of ['databricks', 'tsql', 'snowflake', 'bigquery', 'redshift'] as const) {
			expect(types('select 1 from t', dialect)).toEqual(['SELECT', 'NUMBER', 'FROM', 'VAR']);
		}
	});
});
