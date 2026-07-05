import { describe, it, expect } from 'vitest';
import type { AstPayload, ParseResult } from '../../ftl/parse-result';
import type { SqlParser } from '../../ftl/sql-parser';
import { extractRefs, extractSources, extractMacroCalls, mapWarnings, extractCtes, extractSubqueries, extractFinalColumns, extractFinalSelect, extractTokens, resolveTableRefs, FtlDocumentParser } from '../../ftl/ftl-document-parser';
import { referenceTokenizeJinja as tokenizeJinja } from './reference-jinja-tokenizers';
import type { TableRefToken, ColumnRefToken } from '../../services/parse-service';

describe('extractRefs', () => {
	it('maps a ref tag to RefInfo with precise column positions', () => {
		// "select * from {{ ref('orders') }}"
		//                 ^col 14: jinjaCol (open of {{)
		//                    ^col 17: ref identifier
		//                        ^col 21: opening quote of 'orders'
		//                                ^col 33: jinjaEndCol (after }})
		const sql = 'select * from {{ ref(\'orders\') }}';
		const result = extractRefs(tokenizeJinja(sql));
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({
			model: 'orders',
			line: 0,
			col: 17,
			modelCol: 22,           // first char inside the quotes
			modelEndCol: 28,        // position of closing quote
			jinjaCol: 14,
			jinjaEndCol: 33,
		});
	});

	it('ignores source tags', () => {
		const sql = 'select * from {{ source(\'jaffle_shop\', \'orders\') }}';
		expect(extractRefs(tokenizeJinja(sql))).toHaveLength(0);
	});

	it('returns multiple refs in source order', () => {
		const sql = 'select 1 from {{ ref(\'a\') }} union all select 2 from {{ ref(\'b\') }}';
		const result = extractRefs(tokenizeJinja(sql));
		expect(result.map(r => r.model)).toEqual(['a', 'b']);
	});

	it('returns empty array when there are no jinja tokens', () => {
		expect(extractRefs([])).toEqual([]);
	});
});

describe('extractSources', () => {
	it('maps a source tag to SourceInfo with precise column positions', () => {
		// "select * from {{ source('jaffle_shop', 'raw_orders') }}"
		const sql = 'select * from {{ source(\'jaffle_shop\', \'raw_orders\') }}';
		const result = extractSources(tokenizeJinja(sql));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			sourceName: 'jaffle_shop',
			tableName: 'raw_orders',
			line: 0,
		});
		const r = result[0];
		expect(sql.slice(r.sourceNameCol!, r.sourceNameEndCol!)).toBe('jaffle_shop');
		expect(sql.slice(r.tableNameCol!, r.tableNameEndCol!)).toBe('raw_orders');
		expect(sql.slice(r.jinjaCol!, r.jinjaEndCol!)).toBe('{{ source(\'jaffle_shop\', \'raw_orders\') }}');
	});

	it('ignores ref tags', () => {
		const sql = 'select * from {{ ref(\'orders\') }}';
		expect(extractSources(tokenizeJinja(sql))).toHaveLength(0);
	});

	it('returns multiple sources in source order', () => {
		const sql = 'select * from {{ source(\'s\', \'a\') }} union all select * from {{ source(\'s\', \'b\') }}';
		const result = extractSources(tokenizeJinja(sql));
		expect(result.map(r => r.tableName)).toEqual(['a', 'b']);
	});

	it('returns empty array when there are no jinja tokens', () => {
		expect(extractSources([])).toEqual([]);
	});
});

describe('extractMacroCalls', () => {
	it('captures a simple {{ macro() }} expression call', () => {
		const sql = 'select {{ my_macro(\'a\') }} from t';
		const result = extractMacroCalls(tokenizeJinja(sql));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			name: 'my_macro',
			line: 0,
			args: [{ line: 0, col: 19, endCol: 22 }],
		});
		expect(sql.slice(result[0].col, result[0].endCol)).toBe('my_macro');
		expect(sql.slice(result[0].jinjaCol, result[0].jinjaEndCol)).toBe('{{ my_macro(\'a\') }}');
	});

	it('captures a multi-line {{ ... }} call (the original bug)', () => {
		const sql = 'select {{\n  my_macro(\'a\')\n}} from t';
		const result = extractMacroCalls(tokenizeJinja(sql));
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('my_macro');
		expect(result[0].line).toBe(1);     // identifier on line 1
		expect(result[0].jinjaLine).toBe(0); // {{ on line 0
	});

	it('captures package-qualified calls', () => {
		const sql = 'select {{ dbt_utils.pivot(\'col\', [\'a\']) }} from t';
		const result = extractMacroCalls(tokenizeJinja(sql));
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			name: 'pivot',
			packageName: 'dbt_utils',
		});
	});

	it('captures calls inside {% set %} blocks', () => {
		const sql = '{% set rows = my_macro(\'a\') %}\nselect 1';
		const result = extractMacroCalls(tokenizeJinja(sql));
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('my_macro');
	});

	it('captures calls inside {% if %} blocks', () => {
		const sql = '{% if my_macro(\'x\') %}select 1{% endif %}';
		const result = extractMacroCalls(tokenizeJinja(sql));
		expect(result.map(r => r.name)).toContain('my_macro');
	});

	it('captures the callee in {% call my_macro() %}', () => {
		const sql = '{% call my_macro() %}body{% endcall %}\nselect 1';
		const result = extractMacroCalls(tokenizeJinja(sql));
		expect(result.map(r => r.name)).toEqual(['my_macro']);
	});

	it('skips {% macro foo() %} definition sites', () => {
		const sql = '{% macro foo(x) %}select 1{% endmacro %}';
		expect(extractMacroCalls(tokenizeJinja(sql))).toEqual([]);
	});

	it('skips ref() and source() — handled by their own extractors', () => {
		const sql = 'select * from {{ ref(\'a\') }}, {{ source(\'s\', \'t\') }}';
		expect(extractMacroCalls(tokenizeJinja(sql))).toEqual([]);
	});

	it('skips jinja keywords with parens (if, for, set)', () => {
		const sql = '{% if (x and y) %}select 1{% endif %}';
		expect(extractMacroCalls(tokenizeJinja(sql))).toEqual([]);
	});

	it('skips config() / var() / env_var() globals', () => {
		const sql = '{{ config(materialized=\'view\') }}\nselect {{ var(\'x\') }}';
		expect(extractMacroCalls(tokenizeJinja(sql))).toEqual([]);
	});

	it('records per-argument spans split on top-level commas', () => {
		const sql = 'select {{ my_macro(\'a\', \'b\', \'c\') }} from t';
		const result = extractMacroCalls(tokenizeJinja(sql));
		expect(result).toHaveLength(1);
		expect(result[0].args).toHaveLength(3);
	});

	it('does not split args on commas inside nested parens', () => {
		const sql = 'select {{ outer(inner(1, 2), \'x\') }} from t';
		const result = extractMacroCalls(tokenizeJinja(sql));
		const outer = result.find(r => r.name === 'outer');
		expect(outer).toBeDefined();
		expect(outer!.args).toHaveLength(2);
	});

	it('captures nested calls separately', () => {
		const sql = 'select {{ outer(inner(1)) }} from t';
		const names = extractMacroCalls(tokenizeJinja(sql)).map(r => r.name).sort();
		expect(names).toEqual(['inner', 'outer']);
	});

	it('handles an in-progress call with no closing paren (mid-typing)', () => {
		const sql = 'select {{ my_macro(\'a\',  from t';
		const result = extractMacroCalls(tokenizeJinja(sql));
		// In-progress: depending on tokenizer behavior may or may not emit;
		// at minimum should not throw.
		expect(Array.isArray(result)).toBe(true);
	});

	it('returns empty for files with no jinja', () => {
		expect(extractMacroCalls([])).toEqual([]);
		expect(extractMacroCalls(tokenizeJinja('select 1'))).toEqual([]);
	});
});

describe('mapWarnings', () => {
	it('maps a scope_warning with all fields', () => {
		const result = mapWarnings([{ type: 'scope_warning', message: 'bad cte', line: 1, col: 4, endCol: 10 }]);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ type: 'scope_warning', message: 'bad cte', line: 1, col: 4, endCol: 10 });
	});

	it('maps a syntax_error omitting absent optional fields', () => {
		const result = mapWarnings([{ type: 'syntax_error', message: 'unexpected token' }]);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ type: 'syntax_error', message: 'unexpected token' });
		expect('line' in result[0]).toBe(false);
		expect('col' in result[0]).toBe(false);
		expect('endCol' in result[0]).toBe(false);
	});

	it('maps multiple warnings preserving order', () => {
		const result = mapWarnings([
			{ type: 'syntax_error', message: 'first' },
			{ type: 'scope_warning', message: 'second', line: 3 },
		]);
		expect(result.map(w => w.message)).toEqual(['first', 'second']);
	});

	it('returns empty array for empty input', () => {
		expect(mapWarnings([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// extractCtes
// ---------------------------------------------------------------------------

// SQL: "WITH orders AS (\nSELECT id\nFROM t\n)\nSELECT * FROM orders"
//  offsets:
//   line 0 starts at 0:  "WITH orders AS (" (chars 0-15), \n at 16
//   line 1 starts at 17: "SELECT id"        (chars 17-25), \n at 26
//   line 2 starts at 27: "FROM t"           (chars 27-32), \n at 33
//   line 3 starts at 34: ")"                (char 34),     \n at 35
//   line 4 starts at 36: "SELECT * FROM orders"
//
//  opening paren at 15, closing paren at 34 → endLine=3, endCol=1
//  "orders" m={line:1, col:11} → line=0, col=5  (endCol=11, col=11-6=5)
//  "id"     m={line:2, col:9} → line=1

const simpleSql = 'WITH orders AS (\nSELECT id\nFROM t\n)\nSELECT * FROM orders';

//  AST mirror of that query (pre-order, simplified):
//  [0] With
//  [1] CTE (i=0, k='expressions', a=true)
//  [2] Select body (i=1, k='this')
//  [3] Column (i=2, k='expressions', a=true)
//  [4] Identifier 'id' (i=3, k='this', m={line:2,col:9})
//  [5] leaf v='id' (i=4, k='this')
//  [6] TableAlias (i=1, k='alias')
//  [7] Identifier 'orders' (i=6, k='this', m={line:1,col:11})
//  [8] leaf v='orders' (i=7, k='this')
//  [9] final Select (i=0, k='this')

const simpleAst: AstPayload[] = [
	{ c: 'With' },
	{ c: 'CTE', i: 0, k: 'expressions', a: true },
	{ c: 'Select', i: 1, k: 'this' },
	{ c: 'Column', i: 2, k: 'expressions', a: true },
	{ c: 'Identifier', i: 3, k: 'this', m: { line: 2, col: 9 } },
	{ i: 4, k: 'this', v: 'id' },
	{ c: 'TableAlias', i: 1, k: 'alias' },
	{ c: 'Identifier', i: 6, k: 'this', m: { line: 1, col: 11 } },
	{ i: 7, k: 'this', v: 'orders' },
	{ c: 'Select', i: 0, k: 'this' },
];

describe('extractCtes', () => {
	it('extracts a single CTE with name, position, endLine, endCol, and columns', () => {
		const result = extractCtes(simpleAst, simpleSql);
		expect(result).toHaveLength(1);
		const cte = result[0];
		expect(cte.name).toBe('orders');
		expect(cte.line).toBe(0);
		expect(cte.col).toBe(5);
		expect(cte.endLine).toBe(3);
		expect(cte.endCol).toBe(1);
		expect(cte.columns).toEqual([{ name: 'id', line: 1, col: 7 }]);
	});

	it('returns empty array when there are no CTE nodes', () => {
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Column', i: 0, k: 'expressions', a: true },
		];
		expect(extractCtes(ast, 'SELECT id')).toHaveLength(0);
	});

	it('skips duplicate CTE names', () => {
		// Duplicate CTE — same name twice (union branch scenario)
		const dupAst: AstPayload[] = [
			{ c: 'With' },
			{ c: 'CTE', i: 0, k: 'expressions', a: true },
			{ c: 'Select', i: 1, k: 'this' },
			{ c: 'TableAlias', i: 1, k: 'alias' },
			{ c: 'Identifier', i: 3, k: 'this', m: { line: 1, col: 12 } },
			{ i: 4, k: 'this', v: 'orders' },
			{ c: 'CTE', i: 0, k: 'expressions', a: true },  // duplicate
			{ c: 'Select', i: 6, k: 'this' },
			{ c: 'TableAlias', i: 6, k: 'alias' },
			{ c: 'Identifier', i: 8, k: 'this', m: { line: 1, col: 12 } },
			{ i: 9, k: 'this', v: 'orders' },
		];
		const result = extractCtes(dupAst, simpleSql);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('orders');
	});

	it('skips CTE nodes with no alias', () => {
		const ast: AstPayload[] = [
			{ c: 'With' },
			{ c: 'CTE', i: 0, k: 'expressions', a: true },
			{ c: 'Select', i: 1, k: 'this' },
			// no alias child
		];
		expect(extractCtes(ast, simpleSql)).toHaveLength(0);
	});

	it('extracts alias columns (AS name)', () => {
		// CTE body: SELECT id AS user_id
		// Alias node → leafValue(alias) = 'user_id'; line from Identifier
		const aliasSql = 'WITH t AS (\nSELECT id AS user_id\n)\nSELECT * FROM t';
		const aliasAst: AstPayload[] = [
			{ c: 'With' },
			{ c: 'CTE', i: 0, k: 'expressions', a: true },
			{ c: 'Select', i: 1, k: 'this' },
			{ c: 'Alias', i: 2, k: 'expressions', a: true },
			{ i: 3, k: 'alias', v: 'user_id' },                          // leaf alias string
			{ c: 'Column', i: 3, k: 'this' },                            // the LHS expression
			{ c: 'Identifier', i: 5, k: 'this', m: { line: 2, col: 3 } },// "id"
			{ i: 6, k: 'this', v: 'id' },
			{ c: 'TableAlias', i: 1, k: 'alias' },
			{ c: 'Identifier', i: 8, k: 'this', m: { line: 1, col: 8 } },// "t"
			{ i: 9, k: 'this', v: 't' },
			{ c: 'Select', i: 0, k: 'this' },
		];
		const result = extractCtes(aliasAst, aliasSql);
		expect(result).toHaveLength(1);
		expect(result[0].columns).toEqual([{ name: 'user_id', line: 1, col: 1 }]);
	});

	it('column col points to Column identifier when qualify() wraps a bare column in a synthesised Alias', () => {
		// qualify() synthesises: `losing_team` → `Alias(Column(Identifier "losing_team"), Identifier "losing_team")`
		// The alias Identifier has no _meta. col must fall back to the Column Identifier's position.
		// SQL: WITH t AS (\nSELECT losing_team\n)\nSELECT * FROM t
		//   line 1: "SELECT losing_team"  → "losing_team" starts at col 7
		//   Identifier "losing_team" m={line:2, col:18}  (sqlglot col = exclusive end)
		const synthAliasSql = 'WITH t AS (\nSELECT losing_team\n)\nSELECT * FROM t';
		const synthAliasAst: AstPayload[] = [
			{ c: 'With' },
			{ c: 'CTE', i: 0, k: 'expressions', a: true },
			{ c: 'Select', i: 1, k: 'this' },
			// qualify()-synthesised Alias node — alias Identifier has no _meta
			{ c: 'Alias', i: 2, k: 'expressions', a: true },
			{ c: 'Identifier', i: 3, k: 'alias' },                             // no m (synthesised)
			{ i: 4, k: 'this', v: 'losing_team' },
			{ c: 'Column', i: 3, k: 'this' },
			{ c: 'Identifier', i: 6, k: 'this', m: { line: 2, col: 18 } },     // "losing_team" col=18 → start=7
			{ i: 7, k: 'this', v: 'losing_team' },
			{ c: 'TableAlias', i: 1, k: 'alias' },
			{ c: 'Identifier', i: 9, k: 'this', m: { line: 1, col: 6 } },      // "t"
			{ i: 10, k: 'this', v: 't' },
			{ c: 'Select', i: 0, k: 'this' },
		];
		const result = extractCtes(synthAliasAst, synthAliasSql);
		expect(result).toHaveLength(1);
		// col must be 7 (start of "losing_team"), not 0
		expect(result[0].columns).toEqual([{ name: 'losing_team', line: 1, col: 7 }]);
	});

	it('two CTEs are both extracted in order', () => {
		// WITH a AS (\nSELECT x\n), b AS (\nSELECT y\n)\nSELECT * FROM b
		const twoSql = 'WITH a AS (\nSELECT x\n), b AS (\nSELECT y\n)\nSELECT * FROM b';
		//  offsets:
		//   line 0: "WITH a AS (" (11 chars), \n at 11  → ( at offset 10
		//   line 1: "SELECT x" (8),           \n at 20
		//   line 2: "), b AS (" (9),           \n     → ) at 21, ( at 29? let's check
		//     ")" at 21, "," at 22, " " at 23, "b" at 24, " " at 25, "A" at 26, "S" at 27, " " at 28, "(" at 29
		//   line 3: "SELECT y" (8), \n at 38
		//   ...etc
		//
		// Use two CTEs sharing the same sql: just verify names/counts.
		const twoAst: AstPayload[] = [
			{ c: 'With' },
			{ c: 'CTE', i: 0, k: 'expressions', a: true },    // CTE 'a'
			{ c: 'Select', i: 1, k: 'this' },
			{ c: 'Column', i: 2, k: 'expressions', a: true },
			{ c: 'Identifier', i: 3, k: 'this', m: { line: 2, col: 8 } },  // "x"
			{ i: 4, k: 'this', v: 'x' },
			{ c: 'TableAlias', i: 1, k: 'alias' },
			{ c: 'Identifier', i: 6, k: 'this', m: { line: 1, col: 6 } },  // "a"
			{ i: 7, k: 'this', v: 'a' },
			{ c: 'CTE', i: 0, k: 'expressions', a: true },    // CTE 'b'
			{ c: 'Select', i: 9, k: 'this' },
			{ c: 'Column', i: 10, k: 'expressions', a: true },
			{ c: 'Identifier', i: 11, k: 'this', m: { line: 4, col: 8 } }, // "y"
			{ i: 12, k: 'this', v: 'y' },
			{ c: 'TableAlias', i: 9, k: 'alias' },
			{ c: 'Identifier', i: 14, k: 'this', m: { line: 3, col: 6 } }, // "b"
			{ i: 15, k: 'this', v: 'b' },
			{ c: 'Select', i: 0, k: 'this' },
		];
		const result = extractCtes(twoAst, twoSql);
		expect(result).toHaveLength(2);
		expect(result[0].name).toBe('a');
		expect(result[1].name).toBe('b');
		expect(result[0].columns.map(c => c.name)).toEqual(['x']);
		expect(result[1].columns.map(c => c.name)).toEqual(['y']);
	});

	it('qualified wildcard cp.* produces a * column entry (not cp)', () => {
		// WITH t AS (SELECT cp.* FROM src AS cp)  SELECT * FROM t
		// cp.* is Column(this=Star, table=Identifier('cp'))
		// Must produce columns: [{ name: '*', ... }] to suppress false-positive unused-column violations.
		const sql = 'WITH t AS (\nSELECT cp.*\n)\nSELECT * FROM t';
		const ast: AstPayload[] = [
			{ c: 'With' },                                                         // [0]
			{ c: 'CTE', i: 0, k: 'expressions', a: true },                        // [1]
			{ c: 'Select', i: 1, k: 'this' },                                      // [2]
			{ c: 'Column', i: 2, k: 'expressions', a: true },                     // [3] cp.*
			{ c: 'Star', i: 3, k: 'this' },                                        // [4] the *
			{ c: 'Identifier', i: 3, k: 'table', m: { line: 2, col: 10 } },       // [5] 'cp' qualifier
			{ i: 5, k: 'this', v: 'cp' },                                         // [6]
			{ c: 'TableAlias', i: 1, k: 'alias' },                                // [7]
			{ c: 'Identifier', i: 7, k: 'this', m: { line: 1, col: 6 } },         // [8] CTE name 't'
			{ i: 8, k: 'this', v: 't' },                                          // [9]
			{ c: 'Select', i: 0, k: 'this' },                                     // [10]
		];
		const result = extractCtes(ast, sql);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('t');
		expect(result[0].columns).toHaveLength(1);
		expect(result[0].columns[0].name).toBe('*');
	});
});

// ---------------------------------------------------------------------------
// extractFinalColumns + extractFinalSelect shared fixtures
// ---------------------------------------------------------------------------

// SQL: "SELECT id, name\nFROM t"
// Line 0: "SELECT id, name"  \n
// Line 1: "FROM t"
//
// AST:
//  [0] Select
//  [1] Column  (k='expressions', a=true)  → 'id'
//  [2] Identifier  (i=1, k='this', m={line:1, col:9})  — 'id' ends at col 9 (0-based excl)
//  [3] leaf v='id'
//  [4] Column  (k='expressions', a=true)  → 'name'
//  [5] Identifier  (i=4, k='this', m={line:1, col:15})  — 'name' ends at col 15 (0-based excl)
//  [6] leaf v='name'
//  [7] From   (k='from')
//  [8] Table  (i=7, k='this')
//  [9] Identifier  (i=8, k='this', m={line:2, col:7})
//  [10] leaf v='t'
//
// Column 'id':   m.col=9 (0-based excl-end after 'SELECT id': 9 chars consumed)
//   → line=0, endCol=9, col=9-2=7
//
// Column 'name': m.col=15 (0-based excl-end: 'SELECT id, name' → 15 chars consumed through 'e')
//   → line=0, endCol=15, col=15-4=11

const plainSelectSql = 'SELECT id, name\nFROM t';

const plainSelectAst: AstPayload[] = [
	{ c: 'Select' },
	{ c: 'Column', i: 0, k: 'expressions', a: true },
	{ c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 9 } },   // 'id'
	{ i: 2, k: 'this', v: 'id' },
	{ c: 'Column', i: 0, k: 'expressions', a: true },
	{ c: 'Identifier', i: 4, k: 'this', m: { line: 1, col: 15 } },  // 'name'
	{ i: 5, k: 'this', v: 'name' },
	{ c: 'From', i: 0, k: 'from' },
	{ c: 'Table', i: 7, k: 'this' },
	{ c: 'Identifier', i: 8, k: 'this', m: { line: 2, col: 7 } },
	{ i: 9, k: 'this', v: 't' },
];

// SQL: "WITH base AS (\nSELECT id\nFROM t\n)\nSELECT id, name\nFROM base"
// Line 4: "SELECT id, name"
const withSelectSql = 'WITH base AS (\nSELECT id\nFROM t\n)\nSELECT id, name\nFROM base';
const withSelectAst: AstPayload[] = [
	{ c: 'With' },
	{ c: 'CTE', i: 0, k: 'expressions', a: true },
	{ c: 'Select', i: 1, k: 'this' },
	{ c: 'Column', i: 2, k: 'expressions', a: true },
	{ c: 'Identifier', i: 3, k: 'this', m: { line: 2, col: 9 } },
	{ i: 4, k: 'this', v: 'id' },
	{ c: 'TableAlias', i: 1, k: 'alias' },
	{ c: 'Identifier', i: 6, k: 'this', m: { line: 1, col: 9 } },  // 'base'
	{ i: 7, k: 'this', v: 'base' },
	{ c: 'Select', i: 0, k: 'this' },                               // [9] final SELECT
	{ c: 'Column', i: 9, k: 'expressions', a: true },
	{ c: 'Identifier', i: 10, k: 'this', m: { line: 5, col: 10 } },// 'id' on line 5 (1-based)
	{ i: 11, k: 'this', v: 'id' },
	{ c: 'Column', i: 9, k: 'expressions', a: true },
	{ c: 'Identifier', i: 13, k: 'this', m: { line: 5, col: 16 } },// 'name' on line 5
	{ i: 14, k: 'this', v: 'name' },
];

describe('extractFinalColumns', () => {
	it('extracts column names and lines from a plain SELECT', () => {
		const result = extractFinalColumns(plainSelectAst);
		expect(result).toHaveLength(2);
		expect(result[0]).toMatchObject({ name: 'id', line: 0 });
		expect(result[1]).toMatchObject({ name: 'name', line: 0 });
	});

	it('extracts final SELECT columns from a WITH query (not CTE columns)', () => {
		const result = extractFinalColumns(withSelectAst);
		expect(result).toHaveLength(2);
		expect(result.map(c => c.name)).toEqual(['id', 'name']);
		// All on 0-based line 4 (m.line=5 → 5-1=4)
		expect(result[0].line).toBe(4);
	});

	it('handles alias columns (Identifier-based alias — real serde.dump structure)', () => {
		// SELECT id AS user_id
		// Alias[0] → inner Column[1] → Identifier[2] 'id', + Identifier[3] 'user_id' (k='alias')
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Alias', i: 0, k: 'expressions', a: true },
			{ c: 'Column', i: 1, k: 'this' },
			{ c: 'Identifier', i: 2, k: 'this', m: { line: 1, col: 9 } },  // 'id'
			{ i: 3, k: 'this', v: 'id' },
			{ c: 'Identifier', i: 1, k: 'alias', m: { line: 1, col: 17 } }, // 'user_id'
			{ i: 5, k: 'this', v: 'user_id' },
		];
		const result = extractFinalColumns(ast);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('user_id');
	});

	it('returns empty array for an empty ast', () => {
		expect(extractFinalColumns([])).toEqual([]);
	});

	it('skips Star expressions (no Identifier → no name)', () => {
		// SELECT * → Star node has no Identifier
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Star', i: 0, k: 'expressions', a: true },
		];
		expect(extractFinalColumns(ast)).toEqual([]);
	});
});

describe('extractFinalSelect', () => {
	it('finds SELECT keyword and column bounds for a plain SELECT', () => {
		const result = extractFinalSelect(plainSelectAst, plainSelectSql);
		expect(result).toBeDefined();
		// SELECT keyword on line 0
		expect(result!.line).toBe(0);
		expect(result!.col).toBe(0);
		expect(result!.columns).toHaveLength(2);
		expect(result!.columns[0].name).toBe('id');
		expect(result!.columns[1].name).toBe('name');
		// 'id': m={line:1,col:9} → line=0, col=7, endCol=9
		expect(result!.columns[0].line).toBe(0);
		expect(result!.columns[0].col).toBe(7);
		expect(result!.columns[0].endCol).toBe(9);
		// 'name': m={line:1,col:15} → line=0, col=11, endCol=15
		expect(result!.columns[1].line).toBe(0);
		expect(result!.columns[1].col).toBe(11);
		expect(result!.columns[1].endCol).toBe(15);
		// expression field populated for bare Column nodes
		expect(result!.columns[0].expression).toBe('id');
		expect(result!.columns[1].expression).toBe('name');
	});

	it('extracts final SELECT from a WITH query (not CTE body)', () => {
		const result = extractFinalSelect(withSelectAst, withSelectSql);
		expect(result).toBeDefined();
		expect(result!.columns.map(c => c.name)).toEqual(['id', 'name']);
		expect(result!.line).toBe(4); // line 4 = "SELECT id, name"
	});

	it('extracts alias position for AS expressions', () => {
		// "SELECT id AS user_id" — single line
		// 'id'      m={line:1,col:9}  → line=0, endCol=9,  col=7
		// 'user_id' m={line:1,col:20} → line=0, endCol=20, col=13
		// bounds: min(col=7)..max(endCol=20)
		const sql = 'SELECT id AS user_id';
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Alias', i: 0, k: 'expressions', a: true },
			{ c: 'Column', i: 1, k: 'this' },
			{ c: 'Identifier', i: 2, k: 'this', m: { line: 1, col: 9 } },   // 'id'
			{ i: 3, k: 'this', v: 'id' },
			{ c: 'Identifier', i: 1, k: 'alias', m: { line: 1, col: 20 } }, // 'user_id'
			{ i: 5, k: 'this', v: 'user_id' },
		];
		const result = extractFinalSelect(ast, sql);
		expect(result).toBeDefined();
		const col = result!.columns[0];
		expect(col.name).toBe('user_id');
		expect(col.expression).toBe('id');
		// alias position: m={line:1,col:20} → line=0, endCol=20, col=13
		expect(col.aliasLine).toBe(0);
		expect(col.aliasCol).toBe(13);
		expect(col.aliasEndCol).toBe(20);
	});

	it('extracts table qualifier for qualified columns', () => {
		// "SELECT t.id" — Column with table='t', this='id'
		// 't'  m={line:1,col:8}  → line=0, endCol=8,  col=7
		// 'id' m={line:1,col:11} → line=0, endCol=11, col=9
		const sql = 'SELECT t.id';
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 11 } },  // 'id'
			{ i: 2, k: 'this', v: 'id' },
			{ c: 'Identifier', i: 1, k: 'table', m: { line: 1, col: 8 } },  // 't'
			{ i: 4, k: 'this', v: 't' },
		];
		const result = extractFinalSelect(ast, sql);
		expect(result).toBeDefined();
		const col = result!.columns[0];
		expect(col.name).toBe('id');    // identifierName via findDescendant
		expect(col.expression).toBe('id');
		expect(col.table).toBe('t');
		// bounds: min col from 't' (col=7), max endCol from 'id' (endCol=11)
		expect(col.col).toBe(7);
		expect(col.endCol).toBe(11);
	});

	it('returns undefined for an empty ast', () => {
		expect(extractFinalSelect([], 'SELECT 1')).toBeUndefined();
	});

	it('endLine/endCol of finalSelect tracks the last column', () => {
		// Two-line SELECT: line 0 = "SELECT", line 1 = "  id, name"
		const sql = 'SELECT\n  id, name';
		//  'id': m={line:2, col:4}  → line=1, endCol=4, col=2
		// 'name': m={line:2, col:10} → line=1, endCol=10, col=6
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 2, col: 4 } },
			{ i: 2, k: 'this', v: 'id' },
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 4, k: 'this', m: { line: 2, col: 10 } },
			{ i: 5, k: 'this', v: 'name' },
		];
		const result = extractFinalSelect(ast, sql);
		expect(result).toBeDefined();
		expect(result!.line).toBe(0);  // SELECT keyword on line 0
		expect(result!.endLine).toBe(1);
		expect(result!.endCol).toBe(10); // 'name' endCol
	});

	it('excludes a column whose AST line falls on a -- comment line', () => {
		// SQL line 0: 'SELECT'
		// SQL line 1: '  id,'       ← real column
		// SQL line 2: '  -- ghost,' ← comment — buildCommentedLines adds line 2
		// SQL line 3: '  status'    ← real column
		const sql = 'SELECT\n  id,\n  -- ghost,\n  status';
		const ast: AstPayload[] = [
			// 0: Select
			{ c: 'Select' },
			// 1..3: Column 'id' at 0-based line 1 (m.line=2)
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 2, col: 4 } },
			{ i: 2, k: 'this', v: 'id' },
			// 4..6: Column 'ghost' at 0-based line 2 (m.line=3) — comment line
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 4, k: 'this', m: { line: 3, col: 9 } },
			{ i: 5, k: 'this', v: 'ghost' },
			// 7..9: Column 'status' at 0-based line 3 (m.line=4)
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 7, k: 'this', m: { line: 4, col: 10 } },
			{ i: 8, k: 'this', v: 'status' },
		];
		const result = extractFinalSelect(ast, sql);
		expect(result).toBeDefined();
		expect(result!.columns.map(c => c.name)).toEqual(['id', 'status']);
	});

	it('excludes a column whose AST line falls inside a /* */ block comment', () => {
		// SQL line 0: 'SELECT'
		// SQL line 1: '  id,'     ← real column
		// SQL line 2: '  /*'      ← block comment start — buildCommentedLines adds lines 2,3,4
		// SQL line 3: '  ghost,'  ← inside block comment
		// SQL line 4: '  */'      ← block comment end
		// SQL line 5: '  status'  ← real column
		const sql = 'SELECT\n  id,\n  /*\n  ghost,\n  */\n  status';
		const ast: AstPayload[] = [
			// 0: Select
			{ c: 'Select' },
			// 1..3: Column 'id' at 0-based line 1 (m.line=2)
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 2, col: 4 } },
			{ i: 2, k: 'this', v: 'id' },
			// 4..6: Column 'ghost' at 0-based line 3 (m.line=4) — inside block comment
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 4, k: 'this', m: { line: 4, col: 8 } },
			{ i: 5, k: 'this', v: 'ghost' },
			// 7..9: Column 'status' at 0-based line 5 (m.line=6)
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 7, k: 'this', m: { line: 6, col: 10 } },
			{ i: 8, k: 'this', v: 'status' },
		];
		const result = extractFinalSelect(ast, sql);
		expect(result).toBeDefined();
		expect(result!.columns.map(c => c.name)).toEqual(['id', 'status']);
	});
});

// ---------------------------------------------------------------------------
// extractTokens
// ---------------------------------------------------------------------------

describe('extractTokens', () => {
	it('emits table_ref for each CTE definition that has a col', () => {
		// CTE 'base' at line 0, col 5 → endCol = 5 + 4 = 9
		const ctes = [{ name: 'base', line: 0, col: 5, endLine: 3, endCol: 1, columns: [] }];
		const result = extractTokens([], ctes);
		expect(result).toHaveLength(1);
		expect(result[0]).toEqual({ type: 'table_ref', name: 'base', line: 0, col: 5, endCol: 9, cteDefinition: true });
	});

	it('skips CTE definition token when col is undefined', () => {
		const ctes = [{ name: 'base', line: 0, endLine: 3, endCol: 1, columns: [] }];
		expect(extractTokens([], ctes)).toHaveLength(0);
	});

	it('emits column_ref for Column nodes', () => {
		// SELECT id — one bare Column → Identifier 'id'
		// 'id': m={line:1, col:9} → line=0, endCol=9, col=7
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 9 } },
			{ i: 2, k: 'this', v: 'id' },
		];
		const result = extractTokens(ast, []);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ type: 'column_ref', name: 'id', line: 0, col: 7, endCol: 9 });
		expect((result[0] as any).table).toBeUndefined();
	});

	it('emits column_ref with table qualifier', () => {
		// SELECT t.id
		// 't': m={line:1, col:8} → line=0, endCol=8, col=7
		// 'id': m={line:1,col:11} → line=0, endCol=11, col=9
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Column', i: 0, k: 'expressions', a: true },
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 11 } },  // 'id'
			{ i: 2, k: 'this', v: 'id' },
			{ c: 'Identifier', i: 1, k: 'table', m: { line: 1, col: 8 } },  // 't'
			{ i: 4, k: 'this', v: 't' },
		];
		const result = extractTokens(ast, []);
		expect(result).toHaveLength(1);
		const tok = result[0] as any;
		expect(tok.type).toBe('column_ref');
		expect(tok.name).toBe('id');
		expect(tok.table).toBe('t');
		expect(tok.tableCol).toBe(7);
		expect(tok.tableEndCol).toBe(8);
		expect(tok.tableLine).toBe(0);
	});

	it('emits column_def for Alias nodes (Identifier-based alias)', () => {
		// SELECT id AS user_id
		// 'user_id': m={line:1,col:20} → line=0, endCol=20, col=13
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'Alias', i: 0, k: 'expressions', a: true },
			{ c: 'Column', i: 1, k: 'this' },
			{ c: 'Identifier', i: 2, k: 'this', m: { line: 1, col: 9 } },   // 'id'
			{ i: 3, k: 'this', v: 'id' },
			{ c: 'Identifier', i: 1, k: 'alias', m: { line: 1, col: 20 } }, // 'user_id'
			{ i: 5, k: 'this', v: 'user_id' },
		];
		const result = extractTokens(ast, []);
		// Expect 1 column_ref ('id') + 1 column_def ('user_id')
		const defs = result.filter(t => t.type === 'column_def');
		const refs = result.filter(t => t.type === 'column_ref');
		expect(defs).toHaveLength(1);
		expect(refs).toHaveLength(1);
		expect(defs[0]).toMatchObject({ type: 'column_def', name: 'user_id', line: 0, col: 13, endCol: 20 });
		expect(refs[0]).toMatchObject({ type: 'column_ref', name: 'id' });
	});

	it('emits table_ref for Table nodes (FROM clause)', () => {
		// FROM orders — Table 'orders' at m={line:2, col:13}
		// → line=1, endCol=13, col=7
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'From', i: 0, k: 'from' },
			{ c: 'Table', i: 1, k: 'this' },
			{ c: 'Identifier', i: 2, k: 'this', m: { line: 2, col: 13 } },
			{ i: 3, k: 'this', v: 'orders' },
		];
		const result = extractTokens(ast, []);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({ type: 'table_ref', name: 'orders', line: 1, col: 7, endCol: 13 });
	});

	it('emits table_ref with alias for aliased FROM clause', () => {
		// FROM orders AS o — on a line with 2 leading spaces: '  FROM orders AS o'
		// 'orders': m={line:2,col:13} → line=1, endCol=13, col=7
		// 'o':      m={line:2,col:18} → line=1, endCol=18, col=17
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'From', i: 0, k: 'from' },
			{ c: 'Table', i: 1, k: 'this' },
			{ c: 'Identifier', i: 2, k: 'this', m: { line: 2, col: 13 } },  // 'orders'
			{ i: 3, k: 'this', v: 'orders' },
			{ c: 'TableAlias', i: 2, k: 'alias' },
			{ c: 'Identifier', i: 5, k: 'this', m: { line: 2, col: 18 } },  // 'o'
			{ i: 6, k: 'this', v: 'o' },
		];
		const result = extractTokens(ast, []);
		expect(result).toHaveLength(1);
		const tok = result[0] as any;
		expect(tok.alias).toBe('o');
		expect(tok.aliasLine).toBe(1);
		expect(tok.aliasCol).toBe(17);
		expect(tok.aliasEndCol).toBe(18);
	});

	it('sets alias but no aliasLine for synthesized TableAlias (qualify() expansion)', () => {
		// qualify() adds "orders AS orders" but the synthesised alias Identifier
		// has no _meta → alias is set for column-ref resolution, but aliasLine
		// is not set, signalling it was not user-written.
		const ast: AstPayload[] = [
			{ c: 'Select' },
			{ c: 'From', i: 0, k: 'from' },
			{ c: 'Table', i: 1, k: 'this' },
			{ c: 'Identifier', i: 2, k: 'this', m: { line: 2, col: 13 } },  // 'orders'
			{ i: 3, k: 'this', v: 'orders' },
			{ c: 'TableAlias', i: 2, k: 'alias' },
			{ c: 'Identifier', i: 5, k: 'this' },   // no _meta — synthesised by qualify()
			{ i: 6, k: 'this', v: 'orders' },
		];
		const result = extractTokens(ast, []);
		expect(result).toHaveLength(1);
		const tok = result[0] as any;
		expect(tok.alias).toBe('orders');        // alias present for column-ref resolution
		expect(tok.synthesized).toBe(true);      // flagged as synthesised
		expect(tok.aliasLine).toBeUndefined();   // no source position
		expect(tok.aliasCol).toBeUndefined();
	});

	it('returns empty array for empty AST and no CTEs', () => {
		expect(extractTokens([], [])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// resolveTableRefs
// ---------------------------------------------------------------------------

describe('resolveTableRefs', () => {
	function tableRef(name: string, alias: string, line: number): TableRefToken {
		return { type: 'table_ref', name, alias, line, col: 0, endCol: name.length };
	}

	function columnRef(name: string, table: string, line: number): ColumnRefToken {
		return { type: 'column_ref', name, table, line, col: 0, endCol: name.length };
	}

	it('links column_ref to table_ref by alias', () => {
		const tr = tableRef('orders', 'o', 0);
		const cr = columnRef('id', 'o', 2);
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBe(tr);
	});

	it('is case-insensitive', () => {
		const tr = tableRef('orders', 'O', 0);
		const cr = columnRef('id', 'o', 2);
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBe(tr);
	});

	it('does not link column_ref without a table qualifier', () => {
		const tr = tableRef('orders', 'o', 0);
		const cr: ColumnRefToken = { type: 'column_ref', name: 'id', line: 2, col: 0, endCol: 2 };
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBeUndefined();
	});

	it('does not link when alias does not match', () => {
		const tr = tableRef('orders', 'x', 0);
		const cr = columnRef('id', 'o', 2);
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBeUndefined();
	});

	it('table_ref without alias is not a candidate', () => {
		const tr: TableRefToken = { type: 'table_ref', name: 'orders', line: 0, col: 0, endCol: 6 };
		const cr = columnRef('id', 'orders', 2);
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBeUndefined();
	});

	it('picks closest preceding alias when same alias defined multiple times', () => {
		const tr1 = tableRef('orders', 'o', 0);
		const tr2 = tableRef('items', 'o', 5);
		const cr = columnRef('id', 'o', 7);
		resolveTableRefs([tr1, tr2, cr]);
		expect(cr.resolvedTableRef).toBe(tr2); // line 5 is closer than line 0
	});

	it('uses fallback for alias defined after column (forward reference)', () => {
		const tr = tableRef('orders', 'o', 10);
		const cr = columnRef('id', 'o', 2);
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBe(tr);
	});

	it('tokens in different scopes do not link', () => {
		// Simulate two separate scopes (e.g. two CTE bodies or nested subqueries)
		const tr = tableRef('orders', 'o', 2);
		tr.scopeId = 1;
		const cr = columnRef('id', 'o', 9);
		cr.scopeId = 2;
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBeUndefined();
	});

	it('tokens in the same explicit scope link correctly', () => {
		const tr = tableRef('orders', 'o', 1);
		tr.scopeId = 1;
		const cr = columnRef('id', 'o', 3);
		cr.scopeId = 1;
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBe(tr);
	});

	it('tokens without scopeId share the top-level scope', () => {
		const tr = tableRef('orders', 'o', 7);
		const cr = columnRef('id', 'o', 9);
		resolveTableRefs([tr, cr]);
		expect(cr.resolvedTableRef).toBe(tr);
	});
});

// ---------------------------------------------------------------------------
// FtlDocumentParser
// ---------------------------------------------------------------------------

describe('FtlDocumentParser', () => {
	it('wires all extractors into a DocumentModel', async () => {
		// SELECT id FROM t  — with one ref tag and one warning
		const sql = 'SELECT id\nFROM {{ ref(\'orders\') }}';

		const fakeResult: ParseResult = {
			ast: [
				{ c: 'Select' },
				{ c: 'Column', i: 0, k: 'expressions', a: true },
				{ c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 9 } },
				{ i: 2, k: 'this', v: 'id' },
			],
			scopes: [],
			dialect: 'ansi',
			warnings: [{ type: 'syntax_error', message: 'oops' }],
			timing: { parseMs: 1, qualifyMs: 0, scopeMs: 0, totalMs: 2 },
			jinjaTokens: tokenizeJinja(sql),
		};

		const mockParser: SqlParser = { parse: async () => fakeResult };
		const parser = new FtlDocumentParser(mockParser, { adapterType: 'ansi' });
		const model = await parser.parse(sql);

		expect(model.refs).toHaveLength(1);
		expect(model.refs[0].model).toBe('orders');

		expect(model.sources).toHaveLength(0);

		expect(model.ctes).toHaveLength(0);

		expect(model.finalColumns).toHaveLength(1);
		expect(model.finalColumns[0].name).toBe('id');

		expect(model.finalSelect).toBeDefined();
		expect(model.finalSelect!.columns).toHaveLength(1);

		expect(model.tokens).toHaveLength(1);
		expect(model.tokens[0].type).toBe('column_ref');

		expect(model.sqlglotWarnings).toHaveLength(1);
		expect(model.sqlglotWarnings![0].message).toBe('oops');

		expect(model.timing).toEqual({ parseMs: 1, totalMs: 2 });
	});
});

describe('extractSubqueries', () => {
	it('extracts a simple subquery with alias and columns', () => {
		// SELECT x.col FROM (SELECT col FROM t) AS x
		const ast: AstPayload[] = [
			{ c: 'Select' },                                                    // 0
			{ c: 'Subquery', i: 0, k: 'from', m: { line: 1, col: 19 } },       // 1
			{ c: 'Select', i: 1, k: 'this' },                                   // 2
			{ c: 'Alias', i: 2, k: 'expressions', a: true },                    // 3
			{ c: 'Column', i: 3, k: 'this' },                                   // 4
			{ c: 'Identifier', i: 4, k: 'this', m: { line: 1, col: 14 } },      // 5: "col"
			{ i: 5, k: 'this', v: 'col' },                                      // 6
			{ c: 'Identifier', i: 3, k: 'alias' },                              // 7: synth alias
			{ i: 7, k: 'this', v: 'col' },                                      // 8
			{ c: 'TableAlias', i: 1, k: 'alias' },                              // 9
			{ c: 'Identifier', i: 9, k: 'this', m: { line: 1, col: 42 } },      // 10: "x"
			{ i: 10, k: 'this', v: 'x' },                                       // 11
		];

		const result = extractSubqueries(ast);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe('x');
		expect(result[0].columns).toHaveLength(1);
		expect(result[0].columns[0].name).toBe('col');
	});

	it('extracts ROW_NUMBER alias column from subquery', () => {
		// (SELECT id, ROW_NUMBER() OVER (...) AS rn FROM t) AS x
		const ast: AstPayload[] = [
			{ c: 'Select' },                                                    // 0
			{ c: 'Subquery', i: 0, k: 'from', m: { line: 1, col: 1 } },        // 1
			{ c: 'Select', i: 1, k: 'this' },                                   // 2
			// First column: id (synth alias)
			{ c: 'Alias', i: 2, k: 'expressions', a: true },                    // 3
			{ c: 'Column', i: 3, k: 'this' },                                   // 4
			{ c: 'Identifier', i: 4, k: 'this', m: { line: 1, col: 10 } },      // 5
			{ i: 5, k: 'this', v: 'id' },                                       // 6
			{ c: 'Identifier', i: 3, k: 'alias' },                              // 7
			{ i: 7, k: 'this', v: 'id' },                                       // 8
			// Second column: ROW_NUMBER() AS rn
			{ c: 'Alias', i: 2, k: 'expressions', a: true },                    // 9
			{ c: 'Identifier', i: 9, k: 'alias', m: { line: 1, col: 45 } },     // 10: "rn"
			{ i: 10, k: 'this', v: 'rn' },                                      // 11
			// TableAlias
			{ c: 'TableAlias', i: 1, k: 'alias' },                              // 12
			{ c: 'Identifier', i: 12, k: 'this', m: { line: 1, col: 55 } },     // 13: "x"
			{ i: 13, k: 'this', v: 'x' },                                       // 14
		];

		const result = extractSubqueries(ast);
		expect(result).toHaveLength(1);
		const cols = result[0].columns.map(c => c.name);
		expect(cols).toContain('id');
		expect(cols).toContain('rn');
	});

	it('skips anonymous subquery (no alias)', () => {
		// WHERE id IN (SELECT id FROM u)
		const ast: AstPayload[] = [
			{ c: 'Select' },                                                    // 0
			{ c: 'Subquery', i: 0, k: 'this', m: { line: 1, col: 1 } },        // 1
			{ c: 'Select', i: 1, k: 'this' },                                   // 2
			// No TableAlias child
		];

		const result = extractSubqueries(ast);
		expect(result).toHaveLength(0);
	});

	it('extracts leftmost branch columns from UNION ALL subquery', () => {
		// (SELECT a, b FROM t1 UNION ALL SELECT c, d FROM t2) AS x
		const ast: AstPayload[] = [
			{ c: 'Select' },                                                    // 0
			{ c: 'Subquery', i: 0, k: 'from', m: { line: 1, col: 1 } },        // 1
			{ c: 'Union', i: 1, k: 'this' },                                    // 2
			{ c: 'Select', i: 2, k: 'this' },                                   // 3: leftmost
			{ c: 'Alias', i: 3, k: 'expressions', a: true },                    // 4
			{ c: 'Column', i: 4, k: 'this' },                                   // 5
			{ c: 'Identifier', i: 5, k: 'this', m: { line: 1, col: 9 } },       // 6
			{ i: 6, k: 'this', v: 'a' },                                        // 7
			{ c: 'Identifier', i: 4, k: 'alias' },                              // 8
			{ i: 8, k: 'this', v: 'a' },                                        // 9
			{ c: 'Alias', i: 3, k: 'expressions', a: true },                    // 10
			{ c: 'Column', i: 10, k: 'this' },                                  // 11
			{ c: 'Identifier', i: 11, k: 'this', m: { line: 1, col: 12 } },     // 12
			{ i: 12, k: 'this', v: 'b' },                                       // 13
			{ c: 'Identifier', i: 10, k: 'alias' },                             // 14
			{ i: 14, k: 'this', v: 'b' },                                       // 15
			// TableAlias
			{ c: 'TableAlias', i: 1, k: 'alias' },                              // 16
			{ c: 'Identifier', i: 16, k: 'this', m: { line: 1, col: 60 } },     // 17
			{ i: 17, k: 'this', v: 'x' },                                       // 18
		];

		const result = extractSubqueries(ast);
		expect(result).toHaveLength(1);
		const cols = result[0].columns.map(c => c.name);
		expect(cols).toEqual(['a', 'b']);
	});
});
