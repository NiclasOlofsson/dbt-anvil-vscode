import { describe, expect, it } from 'vitest';
import { parse } from 'sqllens';
import type { Dialect } from '../../../ftl/sqllens/api';
import { mapTokens } from '../../../ftl/sqllens/token-mapper';

/** Parse-carried tokens, the same stream production feeds mapTokens
 *  (document-parser's `primary.tokens`) — carries `consumedAs` verdicts,
 *  where a bare tokenize() stream by contract does not. */
function map(sql: string, dialect: Dialect = 'databricks') {
	return mapTokens(parse(sql, dialect).tokens, sql, dialect);
}

function types(sql: string, dialect: Dialect = 'databricks') {
	return map(sql, dialect).map(t => t.type);
}

describe('mapTokens — clause & compound naming', () => {
	// Column 6 vs the char count of "select": `col` is the 1-based
	// inclusive end column (= 0-based exclusive end), not the start column.
	const sql = 'select a, b\nfrom t\ngroup by a';

	it('emits TokenType names and folds GROUP BY into one token', () => {
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

describe('mapTokens — consumedAs verdicts (sqllens 1.8.0)', () => {
	// The parse's own per-occurrence verdict outranks the curated tables in both
	// directions: a keyword the tables don't know keeps its name when the parse
	// consumed it as a keyword, and a table-listed word used as an identifier
	// maps to VAR. The tables demote to naming (renames/canonicalization) plus
	// fallback membership for unverdicted tokens.
	it('an unknown keyword consumed as a keyword keeps its uppercased text', () => {
		// snowflake scripting LET: keyword-role, consumedAs 'keyword', no table
		// entry. (A bare `let x := 1` is a recovery region — verdict absent —
		// and correctly stays VAR through the fallback; in a script block the
		// parse verdicts it.)
		expect(types('begin let x := 1; end;', 'snowflake')).toContain('LET');
		expect(types('let x := 1', 'snowflake')[0]).toBe('VAR');
	});

	it('a table-listed word consumed as an identifier maps to VAR', () => {
		// redshift lists NAME in its dialect keyword table, but here it is a column.
		const toks = map('select a.name from t', 'redshift');
		const name = toks.find(t => t.start === 9)!;
		expect(name.type).toBe('VAR');
	});
});

describe('mapTokens — verdict kind on mapped tokens', () => {
	// The recasing rules key on the mapped token's own kind (per-occurrence truth)
	// instead of a dialect membership set. Verdicted keywords and types carry it;
	// identifier verdicts and plain identifiers carry none.
	it('a verdicted keyword carries kind "keyword"', () => {
		const sel = map('select a from t').find(t => t.type === 'SELECT')!;
		expect(sel.kind).toBe('keyword');
	});

	it('a folded compound carries kind "keyword" (rules exempt it by shape)', () => {
		const g = map('select a from t group by a').find(t => t.type === 'GROUP_BY')!;
		expect(g.kind).toBe('keyword');
	});

	it('a verdicted type carries kind "type" with the canonical name', () => {
		// databricks STRING verdicts "type" and canonicalizes to TEXT. (postgres
		// int4 lexes as a plain identifier-role token — no verdict, stays VAR.)
		const toks = map('select cast(x as string) from t', 'databricks');
		const text = toks.find(t => t.type === 'TEXT')!;
		expect(text.kind).toBe('type');
	});

	it('identifier verdicts and plain identifiers carry no kind', () => {
		const name = map('select a.name from t', 'redshift').find(t => t.start === 9)!;
		expect(name.type).toBe('VAR');
		expect(name.kind).toBeUndefined();
		const foo = map('select foo from bar').find(t => t.start === 7)!;
		expect(foo.kind).toBeUndefined();
	});
});

describe('mapTokens — soft keywords stay identifiers', () => {
	// ANTLR keyword vocabularies include SOFT keywords: words the lexer tags with
	// role 'keyword' that are identifiers in use (duckdb lexes the column in
	// `a.name` as a NAME keyword token). A naive "keyword role -> keyword type"
	// default broke the kitchen-sink format oracle (`a.NAME` stopped lowercasing),
	// so an unmapped word maps to VAR regardless of lexer role — the KEYWORDS
	// tables are the reserved-vs-soft semantic layer, not just renames. Real
	// keyword membership per dialect needs a reserved/soft split from sqllens
	// (asked on the channel); until then the tables stay curated.
	it('a soft keyword used as a column maps to VAR (identifier), not its own type', () => {
		const toks = map('select a.name from t', 'duckdb');
		const name = toks.find(t => t.start === 9)!; // `name` right after `a.`
		expect(name.type).toBe('VAR');
	});

	it('renamed keywords still map through the tables (AS -> ALIAS)', () => {
		expect(types('select a as b from t', 'snowflake')).toContain('ALIAS');
	});

	it('plain identifiers still map to VAR', () => {
		expect(types('select foo from bar')).toEqual(['SELECT', 'VAR', 'FROM', 'VAR']);
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

describe('mapTokens — whitespace never leaks (token stream emits no whitespace tokens)', () => {
	it('drops every whitespace/newline run across blank lines yet keeps comment attachment', () => {
		// Multi-line SQL with CRLF newlines and blank lines around a comment. The token
		// stream emits NO whitespace tokens; a `\r\n`-typed leak was historically the most frequent mismatch.
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
