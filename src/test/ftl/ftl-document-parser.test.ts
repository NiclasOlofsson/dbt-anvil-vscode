import { describe, it, expect } from 'vitest';
import type { AstPayload, ParseResult } from '../../ftl/parse-result';
import type { JinjaTagSpan } from '../../ftl/parse-result';
import type { SqlParser } from '../../ftl/sql-parser';
import { extractRefs, extractSources, mapWarnings, extractCtes, extractFinalColumns, extractFinalSelect, extractTokens, resolveTableRefs, FtlDocumentParser } from '../../ftl/ftl-document-parser';
import type { CteInfo, TableRefToken, ColumnRefToken } from '../../services/parse-service';

describe('extractRefs', () => {
    it('maps a ref span to RefInfo', () => {
        const tags: JinjaTagSpan[] = [{
            type: 'ref',
            line: 2,
            col: 8,
            model: 'orders',
            modelCol: 14,
            modelEndCol: 20,
            jinjaCol: 5,
            jinjaEndCol: 25,
        }];
        const result = extractRefs(tags);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            model: 'orders',
            line: 2,
            col: 8,
            modelCol: 14,
            modelEndCol: 20,
            jinjaCol: 5,
            jinjaEndCol: 25,
        });
    });

    it('ignores source spans', () => {
        const tags: JinjaTagSpan[] = [{
            type: 'source',
            line: 0, col: 0,
            sourceName: 'jaffle_shop', tableName: 'orders',
            sourceNameCol: 1, sourceNameEndCol: 12,
            tableNameCol: 14, tableNameEndCol: 20,
            jinjaCol: 0, jinjaEndCol: 30,
        }];
        expect(extractRefs(tags)).toHaveLength(0);
    });

    it('returns multiple refs in order', () => {
        const tags: JinjaTagSpan[] = [
            { type: 'ref', line: 0, col: 0, model: 'a', modelCol: 5, modelEndCol: 6, jinjaCol: 0, jinjaEndCol: 10 },
            { type: 'ref', line: 1, col: 0, model: 'b', modelCol: 5, modelEndCol: 6, jinjaCol: 0, jinjaEndCol: 10 },
        ];
        const result = extractRefs(tags);
        expect(result.map(r => r.model)).toEqual(['a', 'b']);
    });

    it('returns empty array for empty tags', () => {
        expect(extractRefs([])).toEqual([]);
    });
});

describe('extractSources', () => {
    it('maps a source span to SourceInfo', () => {
        const tags: JinjaTagSpan[] = [{
            type: 'source',
            line: 3,
            col: 4,
            sourceName: 'jaffle_shop',
            tableName: 'raw_orders',
            sourceNameCol: 12,
            sourceNameEndCol: 23,
            tableNameCol: 26,
            tableNameEndCol: 36,
            jinjaCol: 0,
            jinjaEndCol: 40,
        }];
        const result = extractSources(tags);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
            sourceName: 'jaffle_shop',
            tableName: 'raw_orders',
            line: 3,
            col: 4,
            sourceNameCol: 12,
            sourceNameEndCol: 23,
            tableNameCol: 26,
            tableNameEndCol: 36,
            jinjaCol: 0,
            jinjaEndCol: 40,
        });
    });

    it('ignores ref spans', () => {
        const tags: JinjaTagSpan[] = [{
            type: 'ref',
            line: 0, col: 0, model: 'x',
            modelCol: 0, modelEndCol: 1,
            jinjaCol: 0, jinjaEndCol: 5,
        }];
        expect(extractSources(tags)).toHaveLength(0);
    });

    it('returns multiple sources in order', () => {
        const tags: JinjaTagSpan[] = [
            { type: 'source', line: 0, col: 0, sourceName: 'src', tableName: 'a', sourceNameCol: 0, sourceNameEndCol: 3, tableNameCol: 5, tableNameEndCol: 6, jinjaCol: 0, jinjaEndCol: 10 },
            { type: 'source', line: 1, col: 0, sourceName: 'src', tableName: 'b', sourceNameCol: 0, sourceNameEndCol: 3, tableNameCol: 5, tableNameEndCol: 6, jinjaCol: 0, jinjaEndCol: 10 },
        ];
        const result = extractSources(tags);
        expect(result.map(r => r.tableName)).toEqual(['a', 'b']);
    });

    it('returns empty array for empty tags', () => {
        expect(extractSources([])).toEqual([]);
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
//  "orders" m={line:1, col:12} → line=0, col=5  (endCol_0=11, col_0=11-6=5)
//  "id"     m={line:2, col:10} → line=1

const simpleSql = 'WITH orders AS (\nSELECT id\nFROM t\n)\nSELECT * FROM orders';

//  AST mirror of that query (pre-order, simplified):
//  [0] With
//  [1] CTE (i=0, k='expressions', a=true)
//  [2] Select body (i=1, k='this')
//  [3] Column (i=2, k='expressions', a=true)
//  [4] Identifier 'id' (i=3, k='this', m={line:2,col:10})
//  [5] leaf v='id' (i=4, k='this')
//  [6] TableAlias (i=1, k='alias')
//  [7] Identifier 'orders' (i=6, k='this', m={line:1,col:12})
//  [8] leaf v='orders' (i=7, k='this')
//  [9] final Select (i=0, k='this')

const simpleAst: AstPayload[] = [
    { c: 'With' },
    { c: 'CTE', i: 0, k: 'expressions', a: true },
    { c: 'Select', i: 1, k: 'this' },
    { c: 'Column', i: 2, k: 'expressions', a: true },
    { c: 'Identifier', i: 3, k: 'this', m: { line: 2, col: 10 } },
    { i: 4, k: 'this', v: 'id' },
    { c: 'TableAlias', i: 1, k: 'alias' },
    { c: 'Identifier', i: 6, k: 'this', m: { line: 1, col: 12 } },
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
        expect(cte.columns).toEqual([{ name: 'id', line: 1 }]);
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
        expect(result[0].columns).toEqual([{ name: 'user_id', line: 1 }]);
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
//  [2] Identifier  (i=1, k='this', m={line:1, col:9})  — 'id' ends at col 9 (1-based excl)
//  [3] leaf v='id'
//  [4] Column  (k='expressions', a=true)  → 'name'
//  [5] Identifier  (i=4, k='this', m={line:1, col:15})  — 'name' ends at col 15
//  [6] leaf v='name'
//  [7] From   (k='from')
//  [8] Table  (i=7, k='this')
//  [9] Identifier  (i=8, k='this', m={line:2, col:7})
//  [10] leaf v='t'
//
// Column 'id':   m.line=1 → line=0; m.col=9  → endCol_0=8, col_0=8-2=6  → "SELECT id" at cols 7-8? wait....
//   Let's recount "SELECT id": S(1)E(2)L(3)E(4)C(5)T(6) (7)i(8)d(9) — 'd' at 1-based col 9 → exclusive end = 10.
//   So m.col should be 10 for 'id'. But wait "SELECT id" is 0-based: i at col 7, d at col 8 → exclusive end 9 (0-based)
//   In 1-based: i at col 8, d at col 9 → exclusive end col = 10.
//   So m.col=10 for 'id', m.line=1.
//   identifierPosition: endCol_0 = 10-1 = 9, col_0 = 9-2 = 7, line=0.
//
// Column 'name': "SELECT id, name" — n at col 11 (0-based), ...name ends at 14 (0-based).
//   1-based: 'n' at col 12, 'e' at col 15, exclusive end = 16.
//   m.col=16, m.line=1. endCol_0=15, col_0=15-4=11, line=0.

const plainSelectSql = 'SELECT id, name\nFROM t';

const plainSelectAst: AstPayload[] = [
    { c: 'Select' },
    { c: 'Column', i: 0, k: 'expressions', a: true },
    { c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 10 } },  // 'id'
    { i: 2, k: 'this', v: 'id' },
    { c: 'Column', i: 0, k: 'expressions', a: true },
    { c: 'Identifier', i: 4, k: 'this', m: { line: 1, col: 16 } },  // 'name'
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
        expect(result[0]).toEqual({ name: 'id', line: 0 });
        expect(result[1]).toEqual({ name: 'name', line: 0 });
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
        // 'id': m={line:1,col:10} → line=0, col=7, endCol=9
        expect(result!.columns[0].line).toBe(0);
        expect(result!.columns[0].col).toBe(7);
        expect(result!.columns[0].endCol).toBe(9);
        // 'name': m={line:1,col:16} → line=0, col=11, endCol=15
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
        // 'id'      m={line:1,col:9}  → line=0, endCol=8, col=6
        // 'user_id' m={line:1,col:20} → line=0, endCol=19, col=12
        // bounds: min(col=6)..max(endCol=19)
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
        // alias position: m={line:1,col:20} → line=0, endCol=19, col=12
        expect(col.aliasLine).toBe(0);
        expect(col.aliasCol).toBe(12);
        expect(col.aliasEndCol).toBe(19);
    });

    it('extracts table qualifier for qualified columns', () => {
        // "SELECT t.id" — Column with table='t', this='id'
        // 't'  m={line:1,col:8}  → line=0, endCol=7, col=6
        // 'id' m={line:1,col:11} → line=0, endCol=10, col=8
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
        // bounds: min col from 't' (col=6), max endCol from 'id' (endCol=10)
        expect(col.col).toBe(6);
        expect(col.endCol).toBe(10);
    });

    it('returns undefined for an empty ast', () => {
        expect(extractFinalSelect([], 'SELECT 1')).toBeUndefined();
    });

    it('endLine/endCol of finalSelect tracks the last column', () => {
        // Two-line SELECT: line 0 = "SELECT", line 1 = "  id, name"
        const sql = 'SELECT\n  id, name';
        //  'id': m={line:2, col:4}  → line=1, endCol=3, col=1
        // 'name': m={line:2, col:9} → line=1, endCol=8, col=4
        const ast: AstPayload[] = [
            { c: 'Select' },
            { c: 'Column', i: 0, k: 'expressions', a: true },
            { c: 'Identifier', i: 1, k: 'this', m: { line: 2, col: 4 } },
            { i: 2, k: 'this', v: 'id' },
            { c: 'Column', i: 0, k: 'expressions', a: true },
            { c: 'Identifier', i: 4, k: 'this', m: { line: 2, col: 9 } },
            { i: 5, k: 'this', v: 'name' },
        ];
        const result = extractFinalSelect(ast, sql);
        expect(result).toBeDefined();
        expect(result!.line).toBe(0);  // SELECT keyword on line 0
        expect(result!.endLine).toBe(1);
        expect(result!.endCol).toBe(8); // 'name' endCol
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
        expect(result[0]).toEqual({ type: 'table_ref', name: 'base', line: 0, col: 5, endCol: 9 });
    });

    it('skips CTE definition token when col is undefined', () => {
        const ctes = [{ name: 'base', line: 0, endLine: 3, endCol: 1, columns: [] }];
        expect(extractTokens([], ctes)).toHaveLength(0);
    });

    it('emits column_ref for Column nodes', () => {
        // SELECT id — one bare Column → Identifier 'id'
        // 'id': m={line:1, col:9} → line=0, endCol=8, col=6
        const ast: AstPayload[] = [
            { c: 'Select' },
            { c: 'Column', i: 0, k: 'expressions', a: true },
            { c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 9 } },
            { i: 2, k: 'this', v: 'id' },
        ];
        const result = extractTokens(ast, []);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ type: 'column_ref', name: 'id', line: 0, col: 6, endCol: 8 });
        expect((result[0] as any).table).toBeUndefined();
    });

    it('emits column_ref with table qualifier', () => {
        // SELECT t.id
        // 't': m={line:1, col:8} → line=0, endCol=7, col=6
        // 'id': m={line:1,col:11} → line=0, endCol=10, col=8
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
        expect(tok.tableCol).toBe(6);
        expect(tok.tableEndCol).toBe(7);
        expect(tok.tableLine).toBe(0);
    });

    it('emits column_def for Alias nodes (Identifier-based alias)', () => {
        // SELECT id AS user_id
        // 'user_id': m={line:1,col:20} → line=0, endCol=19, col=12
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
        expect(defs[0]).toMatchObject({ type: 'column_def', name: 'user_id', line: 0, col: 12, endCol: 19 });
        expect(refs[0]).toMatchObject({ type: 'column_ref', name: 'id' });
    });

    it('emits table_ref for Table nodes (FROM clause)', () => {
        // FROM orders — Table 'orders' at m={line:2, col:13}
        // → line=1, endCol=12, col=6
        const ast: AstPayload[] = [
            { c: 'Select' },
            { c: 'From', i: 0, k: 'from' },
            { c: 'Table', i: 1, k: 'this' },
            { c: 'Identifier', i: 2, k: 'this', m: { line: 2, col: 13 } },
            { i: 3, k: 'this', v: 'orders' },
        ];
        const result = extractTokens(ast, []);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ type: 'table_ref', name: 'orders', line: 1, col: 6, endCol: 12 });
    });

    it('emits table_ref with alias for aliased FROM clause', () => {
        // FROM orders AS o
        // 'orders': m={line:2,col:13} → line=1, endCol=12, col=6
        // 'o':      m={line:2,col:18} → line=1, endCol=17, col=16
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
        expect(tok.aliasCol).toBe(16);
        expect(tok.aliasEndCol).toBe(17);
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
        resolveTableRefs([tr, cr], []);
        expect(cr.resolvedTableRef).toBe(tr);
    });

    it('is case-insensitive', () => {
        const tr = tableRef('orders', 'O', 0);
        const cr = columnRef('id', 'o', 2);
        resolveTableRefs([tr, cr], []);
        expect(cr.resolvedTableRef).toBe(tr);
    });

    it('does not link column_ref without a table qualifier', () => {
        const tr = tableRef('orders', 'o', 0);
        const cr: ColumnRefToken = { type: 'column_ref', name: 'id', line: 2, col: 0, endCol: 2 };
        resolveTableRefs([tr, cr], []);
        expect(cr.resolvedTableRef).toBeUndefined();
    });

    it('does not link when alias does not match', () => {
        const tr = tableRef('orders', 'x', 0);
        const cr = columnRef('id', 'o', 2);
        resolveTableRefs([tr, cr], []);
        expect(cr.resolvedTableRef).toBeUndefined();
    });

    it('table_ref without alias is not a candidate', () => {
        const tr: TableRefToken = { type: 'table_ref', name: 'orders', line: 0, col: 0, endCol: 6 };
        const cr = columnRef('id', 'orders', 2);
        resolveTableRefs([tr, cr], []);
        expect(cr.resolvedTableRef).toBeUndefined();
    });

    it('picks closest preceding alias when same alias defined multiple times', () => {
        const tr1 = tableRef('orders', 'o', 0);
        const tr2 = tableRef('items', 'o', 5);
        const cr = columnRef('id', 'o', 7);
        resolveTableRefs([tr1, tr2, cr], []);
        expect(cr.resolvedTableRef).toBe(tr2); // line 5 is closer than line 0
    });

    it('uses fallback for alias defined after column (forward reference)', () => {
        const tr = tableRef('orders', 'o', 10);
        const cr = columnRef('id', 'o', 2);
        resolveTableRefs([tr, cr], []);
        expect(cr.resolvedTableRef).toBe(tr);
    });

    it('constrains to CTE scope — does not cross CTE boundaries', () => {
        const ctes: CteInfo[] = [
            { name: 'cte_a', line: 0, endLine: 5, columns: [] },
            { name: 'cte_b', line: 7, endLine: 12, columns: [] },
        ];
        // table_ref in cte_a scope, column_ref in cte_b scope — should NOT link
        const tr = tableRef('orders', 'o', 2);   // inside cte_a
        const cr = columnRef('id', 'o', 9);      // inside cte_b
        resolveTableRefs([tr, cr], ctes);
        expect(cr.resolvedTableRef).toBeUndefined();
    });

    it('links within the same CTE scope', () => {
        const ctes: CteInfo[] = [{ name: 'cte_a', line: 0, endLine: 5, columns: [] }];
        const tr = tableRef('orders', 'o', 1);   // inside cte_a
        const cr = columnRef('id', 'o', 3);      // inside cte_a
        resolveTableRefs([tr, cr], ctes);
        expect(cr.resolvedTableRef).toBe(tr);
    });

    it('links in final SELECT scope (outside all CTEs)', () => {
        const ctes: CteInfo[] = [{ name: 'cte_a', line: 0, endLine: 5, columns: [] }];
        const tr = tableRef('orders', 'o', 7);   // outside CTE
        const cr = columnRef('id', 'o', 9);      // outside CTE
        resolveTableRefs([tr, cr], ctes);
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
            jinjaTags: [{
                type: 'ref',
                line: 1, col: 5,
                model: 'orders',
                modelCol: 11, modelEndCol: 17,
                jinjaCol: 5, jinjaEndCol: 26,
            }],
        };

        const mockParser: SqlParser = { parse: async () => fakeResult };
        const parser = new FtlDocumentParser(mockParser);
        const model = await parser.parse(sql, 'ansi');

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
