import * as path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';
import { initPyodide } from '../../ftl/pyodide-loader.js';
import type { PyodideRuntime } from '../../ftl/pyodide-loader.js';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser.js';
import { renToRawLine } from '../../ftl/nunjucks-renderer.js';
import { walkLineageTree } from '../../ftl/ftl-document-parser.js';
import type { LineageTreeNode, LineageResult } from '../../ftl/ftl-document-parser.js';

const PYODIDE_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'bridge', 'vendor');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'ftl');

let runtime: PyodideRuntime;
let parser: PyodideSqlParser;

beforeAll(async () => {
    runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
    parser = PyodideSqlParser.create(runtime.pyodide);
}, 60_000);

describe('PyodideSqlParser', () => {
    it('returns an ast array for simple SELECT', async () => {
        const result = await parser.parse('SELECT id, name FROM users', 'duckdb');
        expect(Array.isArray(result.ast)).toBe(true);
        expect(result.ast.length).toBeGreaterThan(0);
    });

    it('returns position metadata on identifier nodes', async () => {
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        const withPos = result.ast.filter(n => n.m?.line !== undefined);
        expect(withPos.length).toBeGreaterThan(0);
        const first = withPos[0].m!;
        expect(typeof first.line).toBe('number');
        expect(typeof first.col).toBe('number');
        expect(typeof first.start).toBe('number');
        expect(first.line).toBeGreaterThanOrEqual(1);
    });

    it('returns scopes array with a root scope', async () => {
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        expect(Array.isArray(result.scopes)).toBe(true);
        expect(result.scopes.length).toBeGreaterThan(0);
        expect(result.scopes[0].type).toBe('root');
    });

    it('returns dialect in result', async () => {
        const result = await parser.parse('SELECT 1', 'duckdb');
        expect(result.dialect).toBe('duckdb');
    });

    it('returns timing with numeric fields', async () => {
        const result = await parser.parse('SELECT 1 + 1', 'duckdb');
        expect(typeof result.timing.parseMs).toBe('number');
        expect(typeof result.timing.totalMs).toBe('number');
        expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    });

    it('handles CTE with subquery scopes', async () => {
        const sql = `
            WITH base AS (SELECT id FROM users)
            SELECT id FROM base
        `;
        const result = await parser.parse(sql, 'duckdb');
        expect(result.scopes.some(s => s.type === 'cte')).toBe(true);
    });

    it('populates sources in root scope', async () => {
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        const root = result.scopes[0];
        expect(Object.keys(root.sources).length).toBeGreaterThan(0);
    });

    it('preserves correct line numbers when a multi-line Jinja tag precedes the SELECT', async () => {
        // Pass 1 (identifier mode): macro → bare identifier before SELECT → syntax error.
        // Pass 1b (comment mode): macro → /* ... */ block comment → valid SQL.
        // Line numbers are still exact in pass 1b (same byte length).
        // The SELECT is on line 6 — 'id' must report line 6 in the AST.
        const sql = [
            '{{',                     // line 1
            '  some_macro(',          // line 2
            '    "arg"',              // line 3
            '  )',                    // line 4
            '}}',                     // line 5
            'SELECT id FROM users',   // line 6
        ].join('\n');
        const result = await parser.parse(sql, 'duckdb');
        expect(result.ast.length).toBeGreaterThan(0);
        // Every node with a line number must report line >= 6 (the SELECT line).
        const linesReported = result.ast
            .map(n => n.m?.line)
            .filter((l): l is number => l !== undefined);
        expect(linesReported.length).toBeGreaterThan(0);
        expect(Math.min(...linesReported)).toBeGreaterThanOrEqual(6);
    });

    it('handles Jinja block comment tags {# #}', async () => {
        const sql = `{# This is a Jinja comment #}
WITH orders AS (
    {#- another comment -#}
    SELECT order_id, amount FROM raw_orders
)
SELECT order_id, amount FROM orders`;
        const result = await parser.parse(sql, 'duckdb');
        expect(result.ast.length).toBeGreaterThan(0);
        expect(result.warnings.some(w => w.type === 'syntax_error')).toBe(false);
        expect(result.scopes.some(s => s.type === 'cte')).toBe(true);
    });

    it('handles Jinja block tags and expression tags', async () => {
        const sql = `{% set my_var = 'foo' %}
WITH orders AS (
    SELECT order_id, {{ 'amount' }} FROM raw_orders
)
SELECT * FROM orders`;
        const result = await parser.parse(sql, 'duckdb');
        expect(result.ast.length).toBeGreaterThan(0);
        expect(result.warnings.some(w => w.type === 'syntax_error')).toBe(false);
        expect(result.scopes.some(s => s.type === 'cte')).toBe(true);
    });

    it('handles {{ config(...) }} at the top of the file', async () => {
        // config() is a statement-macro — must blank to spaces, not '_'.
        // A bare '_' before 'WITH' would cause a parse error.
        const sql = `{{ config(materialized='table') }}

WITH orders AS (
    SELECT order_id FROM raw_orders
)
SELECT * FROM orders`;
        const result = await parser.parse(sql, 'duckdb');
        expect(result.ast.length).toBeGreaterThan(0);
        expect(result.warnings.some(w => w.type === 'syntax_error')).toBe(false);
        expect(result.scopes.some(s => s.type === 'cte')).toBe(true);
    });

    it('handles a statement-level macro between JOIN and UNION ALL (pass 1b)', async () => {
        // {{ generic_is_deleted() }} in identifier mode becomes a bare identifier
        // between a JOIN clause and UNION ALL — invalid SQL.
        // Pass 1b (comment mode) produces /* ... */ which is valid everywhere.
        const sql = `WITH warehouse AS (
    SELECT wh.mkey, ss.sourcename
    FROM gold__warehouse wh
    LEFT JOIN gold__sourcesystem ss
        ON ss.sourcename = wh.sourcesystembkey
    {{ generic_is_deleted(wh.is_deleted) }}
    UNION ALL
    SELECT wh2.mkey, ss2.sourcename
    FROM gold__warehouse2 wh2
    LEFT JOIN gold__sourcesystem ss2
        ON ss2.sourcename = wh2.sourcesystembkey
    {{ generic_is_deleted(wh2.is_deleted) }}
)
SELECT mkey, sourcename FROM warehouse`;
        const result = await parser.parse(sql, 'duckdb');
        expect(result.ast.length).toBeGreaterThan(0);
        expect(result.scopes.some(s => s.type === 'cte')).toBe(true);
    });

    it('reports correct line numbers for table references in a CTE query', async () => {
        // After qualify, column Identifier nodes are rewritten (no positions).
        // Table Identifier nodes always retain their original positions.
        // This verifies remapAstLines is a no-op when no Jinja is present (pass 1 identity).
        const sql = [
            'WITH base AS (',           // line 1
            '    SELECT id',            // line 2
            '    FROM raw_orders',      // line 3
            ')',                        // line 4
            'SELECT * FROM base',       // line 5
        ].join('\n');
        const result = await parser.parse(sql, 'duckdb');
        expect(result.ast.length).toBeGreaterThan(0);
        // raw_orders is a unique name — its Identifier node must be on line 3.
        // serde.dump() emits Identifier nodes with m, followed by child value nodes.
        for (let i = 0; i < result.ast.length - 1; i++) {
            const n = result.ast[i];
            const child = result.ast[i + 1];
            if (n.c === 'Identifier' && child.v === 'raw_orders' && n.m?.line !== undefined) {
                expect(n.m.line).toBe(3);
                return; // found
            }
        }
        throw new Error('raw_orders Identifier node with position not found in AST');
    });

    it('reports no warnings for valid SQL', async () => {
        const result = await parser.parse(
            'with orders as (\n    select order_id, amount from raw_orders\n)\nselect order_id, amount from orders',
            'duckdb',
        );
        expect(result.warnings.filter(w => w.type === 'syntax_error')).toHaveLength(0);
    });

    it('reports a syntax_error with position for a typo in a keyword', async () => {
        // 'FRON' is not a keyword — sqlglot interprets it as a column alias,
        // making 'orders' the unexpected token at col 21 (0-based), endCol 27.
        const result = await parser.parse('select order_id FRON orders', 'duckdb');
        const syntaxErr = result.warnings.find(w => w.type === 'syntax_error');
        expect(syntaxErr).toBeDefined();
        expect(syntaxErr!.line).toBe(0);
        expect(syntaxErr!.col).toBe(21);
        expect(syntaxErr!.endCol).toBe(27);
    });

    it('syntax_error line and col are 0-based for a multi-line query', async () => {
        // Typo on line 3 (0-based): 'orders' flags at col 21, endCol 27.
        const result = await parser.parse(
            'with orders as (\n    select order_id from raw_orders\n)\nselect order_id FRON orders',
            'duckdb',
        );
        const syntaxErr = result.warnings.find(w => w.type === 'syntax_error');
        expect(syntaxErr).toBeDefined();
        expect(syntaxErr!.line).toBe(3);
        expect(syntaxErr!.col).toBe(21);
        expect(syntaxErr!.endCol).toBe(27);
    });

    it('qualify resolves bare column references when schema is provided', async () => {
        // Without schema, qualify() can only infer — bare column refs stay unqualified.
        // With schema, qualify() knows raw_orders has these columns and rewrites
        // column refs to include the table qualifier (e.g. raw_orders.amount).
        // We verify by checking the scope's output columns — qualify must succeed
        // without errors and the root scope must see raw_orders as a source.
        const schema = {
            raw_orders: { order_id: 'INT', amount: 'NUMERIC', status: 'TEXT' },
        };
        const sql = 'SELECT order_id, amount FROM raw_orders WHERE status = \'complete\'';
        const result = await parser.parse(sql, 'duckdb', schema);
        expect(result.warnings.filter(w => w.type === 'syntax_error')).toHaveLength(0);
        const root = result.scopes[0];
        expect(root.type).toBe('root');
        expect(Object.keys(root.sources)).toContain('raw_orders');
        expect(root.columns).toEqual(expect.arrayContaining(['order_id', 'amount']));
    });

    it('qualify resolves columns in a CTE query with schema', async () => {
        const schema = {
            raw_orders: { order_id: 'INT', customer_id: 'INT', amount: 'NUMERIC' },
        };
        const sql = [
            'WITH orders AS (',
            '    SELECT order_id, customer_id, amount FROM raw_orders',
            ')',
            'SELECT order_id, SUM(amount) AS total FROM orders GROUP BY order_id',
        ].join('\n');
        const result = await parser.parse(sql, 'duckdb', schema);
        expect(result.warnings.filter(w => w.type === 'syntax_error')).toHaveLength(0);
        // CTE scope must list raw_orders as a source
        const cteScope = result.scopes.find(s => s.type === 'cte');
        expect(cteScope).toBeDefined();
        expect(Object.keys(cteScope!.sources)).toContain('raw_orders');
        // Root scope must list the CTE as a source
        const root = result.scopes[0];
        expect(Object.keys(root.sources)).toContain('orders');
    });

    it('qualify expands star selectors through a CTE using only schema input', async () => {
        // No column names appear anywhere in SQL — only SELECT * throughout.
        // qualify() must propagate the schema through the CTE to expand * at the root.
        const schema = {
            raw_orders: { order_id: 'INT', customer_id: 'INT', amount: 'NUMERIC' },
        };
        const sql = [
            'WITH orders AS (',
            '    SELECT * FROM raw_orders',
            ')',
            'SELECT * FROM orders',
        ].join('\n');
        const result = await parser.parse(sql, 'duckdb', schema);
        expect(result.warnings.filter(w => w.type === 'syntax_error')).toHaveLength(0);
        // CTE scope: * must have been expanded to the three columns from schema
        const cteScope = result.scopes.find(s => s.type === 'cte');
        expect(cteScope).toBeDefined();
        expect(cteScope!.columns).toEqual(expect.arrayContaining(['order_id', 'customer_id', 'amount']));
        expect(cteScope!.columns).not.toContain('*');
        // Root scope: * also expanded via the CTE's resolved output
        const root = result.scopes[0];
        expect(root.columns).toEqual(expect.arrayContaining(['order_id', 'customer_id', 'amount']));
        expect(root.columns).not.toContain('*');
    });

    it('star selectors are NOT expanded without a schema', async () => {
        // Same query — no schema passed. qualify() has no column info so * stays unexpanded.
        const sql = [
            'WITH orders AS (',
            '    SELECT * FROM raw_orders',
            ')',
            'SELECT * FROM orders',
        ].join('\n');
        const result = await parser.parse(sql, 'duckdb');
        expect(result.warnings.filter(w => w.type === 'syntax_error')).toHaveLength(0);
        const cteScope = result.scopes.find(s => s.type === 'cte');
        expect(cteScope).toBeDefined();
        expect(cteScope!.columns).toContain('*');
        const root = result.scopes[0];
        expect(root.columns).toContain('*');
    });

    // ── jinjaTags (populated by extractJinjaSpans on raw SQL) ─────────────

    it('populates jinjaTags with a ref entry for a ref() tag', async () => {
        const sql = "SELECT * FROM {{ ref('orders') }}";
        const result = await parser.parse(sql, 'duckdb');

        expect(result.jinjaTags).toBeDefined();
        expect(result.jinjaTags).toHaveLength(1);
        const span = result.jinjaTags![0];
        expect(span.type).toBe('ref');
        if (span.type !== 'ref') return;
        expect(span.model).toBe('orders');
        expect(span.line).toBe(0);
        // '{{' is at offset 14 on a single-line SQL
        expect(span.jinjaCol).toBe(14);
    });

    it('populates jinjaTags with a source entry for a source() tag', async () => {
        const sql = "SELECT * FROM {{ source('raw', 'orders') }}";
        const result = await parser.parse(sql, 'duckdb');

        expect(result.jinjaTags).toBeDefined();
        expect(result.jinjaTags).toHaveLength(1);
        const span = result.jinjaTags![0];
        expect(span.type).toBe('source');
        if (span.type !== 'source') return;
        expect(span.sourceName).toBe('raw');
        expect(span.tableName).toBe('orders');
    });

    it('jinjaTags positions are in raw-source space even when pass 2 is used', async () => {
        // This SQL requires pass 2 (nunjucks): a statement-level macro forces
        // the nunjucks render path.  jinjaTags must still report raw-source positions.
        const sql = [
            '{{ config(materialized=\'table\') }}',   // line 0 — statement macro
            "SELECT * FROM {{ ref('orders') }}",      // line 1
        ].join('\n');
        const result = await parser.parse(sql, 'duckdb');

        expect(result.jinjaTags).toBeDefined();
        const refSpan = result.jinjaTags!.find(s => s.type === 'ref');
        expect(refSpan).toBeDefined();
        if (!refSpan || refSpan.type !== 'ref') return;
        // ref() is on line 1 in the raw SQL regardless of which pass was used.
        expect(refSpan.line).toBe(1);
        expect(refSpan.model).toBe('orders');
    });

    it('jinjaTags is empty for SQL with no ref/source tags', async () => {
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        expect(result.jinjaTags).toBeDefined();
        expect(result.jinjaTags).toHaveLength(0);
    });

    // ── sqlTokens ──────────────────────────────────────────────────────────

    it('sqlTokens is a non-empty array for a successful parse', async () => {
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        expect(Array.isArray(result.sqlTokens)).toBe(true);
        expect(result.sqlTokens!.length).toBeGreaterThan(0);
    });

    it('first token of SELECT query has type SELECT', async () => {
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        expect(result.sqlTokens![0].type).toBe('SELECT');
    });

    it('sqlToken positions are in source order', async () => {
        const result = await parser.parse('SELECT id, name FROM users WHERE id = 1', 'duckdb');
        const tokens = result.sqlTokens!;
        for (let i = 1; i < tokens.length; i++) {
            expect(tokens[i].start).toBeGreaterThanOrEqual(tokens[i - 1].start);
        }
    });

    it('sqlToken line numbers are 0-based', async () => {
        const result = await parser.parse('SELECT id\nFROM users', 'duckdb');
        const fromTok = result.sqlTokens!.find(t => t.type === 'FROM');
        expect(fromTok).toBeDefined();
        expect(fromTok!.line).toBe(1);
    });

    it('sqlToken start/end/col positions match exact source offsets', async () => {
        // "SELECT id FROM users"
        //  0123456789...
        // col is sqlglot's 1-based end col (= 0-based exclusive end)
        // SELECT: start=0, end=5,  col=6  (len=6)
        // id:     start=7, end=8,  col=9  (len=2)
        // FROM:   start=10, end=13, col=14 (len=4)
        // users:  start=15, end=19, col=20 (len=5)
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        const tokens = result.sqlTokens!;
        const select = tokens.find(t => t.type === 'SELECT')!;
        const id     = tokens.find(t => t.type === 'VAR' && t.start === 7)!;
        const from   = tokens.find(t => t.type === 'FROM')!;
        const users  = tokens.find(t => t.type === 'VAR' && t.start === 15)!;

        expect(select).toMatchObject({ start: 0,  end: 5,  line: 0, col: 6  });
        expect(id    ).toMatchObject({ start: 7,  end: 8,  line: 0, col: 9  });
        expect(from  ).toMatchObject({ start: 10, end: 13, line: 0, col: 14 });
        expect(users ).toMatchObject({ start: 15, end: 19, line: 0, col: 20 });
    });

    it('sqlToken col is 1-based end col on a new line', async () => {
        // "SELECT id\nFROM users"
        // FROM is at line=1, start=10, end=13, col=4 (1-based end col on line 1)
        const result = await parser.parse('SELECT id\nFROM users', 'duckdb');
        const fromTok = result.sqlTokens!.find(t => t.type === 'FROM')!;
        expect(fromTok).toMatchObject({ start: 10, end: 13, line: 1, col: 4 });
    });

    it('timing.tokenizeMs is a non-negative number on successful parse', async () => {
        const result = await parser.parse('SELECT id FROM users', 'duckdb');
        expect(typeof result.timing.tokenizeMs).toBe('number');
        expect(result.timing.tokenizeMs!).toBeGreaterThanOrEqual(0);
    });

    it('sqlTokens is populated even on parse error', async () => {
        // Tokenizer is more lenient than parser — tokens are always available
        // regardless of whether the AST could be built.
        const result = await parser.parse('SELECT FROM FROM FROM', 'duckdb');
        expect(Array.isArray(result.sqlTokens)).toBe(true);
        // Even broken SQL tokenizes: SELECT, FROM, FROM, FROM, semicolon/EOF
        expect(result.sqlTokens!.length).toBeGreaterThan(0);
        expect(result.sqlTokens!.some(t => t.type === 'SELECT')).toBe(true);
    });
});

// ── renToRawLine — pure unit tests (no pyodide needed) ───────────────────────

describe('renToRawLine', () => {
    it('returns ren_line unchanged when line map is empty', () => {
        expect(renToRawLine(5, [])).toBe(5);
    });

    it('returns ren_line unchanged when there is only (0,0) breakpoint (no divergence)', () => {
        expect(renToRawLine(3, [[0, 0]])).toBe(3);
        expect(renToRawLine(0, [[0, 0]])).toBe(0);
    });

    it('offsets correctly after one diverging tag', () => {
        // A 3-line tag at raw lines 1-3 compresses to nothing in rendered.
        // Before the tag: ren=0 raw=0. After tag: ren still 0, raw=3.
        // Breakpoint: [0, 3] — meaning ren line 0 aligns to raw line 3.
        // But we also need the initial [0,0] breakpoint.
        // Actually: before tag (literal up to line 1): ren=1, raw=1.
        // Tag spans lines 1-3 (3 newlines): raw advances to 4, ren stays at 1.
        // Breakpoint emitted: [1, 4].
        // So line map: [[0,0], [1,4]].
        const map: Array<[number, number]> = [[0, 0], [1, 4]];
        // Before the tag (ren line 0 = raw line 0):
        expect(renToRawLine(0, map)).toBe(0);
        // At and after the tag (ren line 1 = raw line 4):
        expect(renToRawLine(1, map)).toBe(4);
        // Two lines after the tag (ren line 3 = raw line 6):
        expect(renToRawLine(3, map)).toBe(6);
    });

    it('handles multiple breakpoints — second tag', () => {
        // Line map: [[0,0], [2,5], [4,9]]
        const map: Array<[number, number]> = [[0, 0], [2, 5], [4, 9]];
        expect(renToRawLine(0, map)).toBe(0);  // before any tag
        expect(renToRawLine(1, map)).toBe(1);  // still in first region
        expect(renToRawLine(2, map)).toBe(5);  // at second breakpoint
        expect(renToRawLine(3, map)).toBe(6);  // between breakpoints
        expect(renToRawLine(4, map)).toBe(9);  // at third breakpoint
        expect(renToRawLine(5, map)).toBe(10); // after last breakpoint
    });
});

// ── traceLineageV2 — end-to-end: Python _trace_lineage_v2 + walkLineageTree ─

/** Runs parser.traceLineageV2 and applies walkLineageTree, mirroring FtlDocumentParser. */
function traceV2(sql: string, column: string, dialect = 'duckdb', schemaJson = ''): LineageResult | null {
    const raw = parser.traceLineageV2(sql, column, dialect, schemaJson);
    const result = JSON.parse(raw) as { success: boolean; tree?: LineageTreeNode };
    if (!result.success) return null;
    return walkLineageTree(result.tree!);
}

describe('traceLineageV2', () => {
    it('returns a dependency on the source table for a simple SELECT', () => {
        const result = traceV2('SELECT customer_id FROM orders', 'customer_id');
        expect(result).not.toBeNull();
        expect(result!.dependencies).toContainEqual(
            expect.objectContaining({ column: 'customer_id', table: 'orders' }),
        );
        expect(result!.via_ctes).toHaveLength(0);
    });

    it('populates transformations with a table entry for the source table', () => {
        const result = traceV2('SELECT customer_id FROM orders', 'customer_id');
        expect(result).not.toBeNull();
        const tableTrans = result!.transformations.find(t => t.type === 'table' && t.id === 'table:orders');
        expect(tableTrans).toBeDefined();
        expect(tableTrans!.column).toBe('customer_id');
    });

    it('traces through a single CTE and populates via_ctes', () => {
        const sql = [
            'WITH base AS (',
            '    SELECT customer_id FROM raw_orders',
            ')',
            'SELECT customer_id FROM base',
        ].join('\n');
        const result = traceV2(sql, 'customer_id');
        expect(result).not.toBeNull();
        expect(result!.dependencies).toContainEqual(
            expect.objectContaining({ column: 'customer_id', table: 'raw_orders' }),
        );
        expect(result!.via_ctes).toContain('base');
        expect(result!.transformations.some(t => t.type === 'cte' && t.id === 'cte:base')).toBe(true);
    });

    it('collects all intermediate CTE names in via_ctes for a chained CTE query', () => {
        const sql = [
            'WITH base AS (',
            '    SELECT customer_id FROM raw_orders',
            '),',
            'final AS (',
            '    SELECT customer_id FROM base',
            ')',
            'SELECT customer_id FROM final',
        ].join('\n');
        const result = traceV2(sql, 'customer_id');
        expect(result).not.toBeNull();
        expect(result!.via_ctes).toContain('base');
        expect(result!.via_ctes).toContain('final');
        expect(result!.dependencies).toContainEqual(
            expect.objectContaining({ column: 'customer_id', table: 'raw_orders' }),
        );
    });

    it('succeeds for SQL containing a Jinja statement-level macro (pass 1b path)', () => {
        // {{ config(...) }} is a statement-level macro — identifier-blank mode produces
        // a bare identifier before SELECT which is invalid SQL (syntax error).
        // Pass 1b (comment-mode blank) replaces it with /* ... */ and parses cleanly.
        const sql = [
            "{{ config(materialized='table') }}",
            'SELECT customer_id FROM orders',
        ].join('\n');
        const result = traceV2(sql, 'customer_id');
        expect(result).not.toBeNull();
        expect(result!.dependencies).toContainEqual(
            expect.objectContaining({ column: 'customer_id', table: 'orders' }),
        );
    });

    it('includes schema and database on the dependency when the table is schema-qualified', () => {
        // DuckDB allows schema-qualified references: schema.table
        const result = traceV2('SELECT customer_id FROM staging.raw_orders', 'customer_id');
        expect(result).not.toBeNull();
        const dep = result!.dependencies.find(d => d.column === 'customer_id');
        expect(dep).toBeDefined();
        expect(dep!.table).toBe('raw_orders');
        expect(dep!.schema).toBe('staging');
    });

    it('returns empty dependencies for a column that does not appear in the SELECT list', () => {
        // nonexistent_col is not projected — Python still returns success:true with an empty tree
        const result = traceV2('SELECT customer_id FROM orders', 'nonexistent_col');
        expect(result).not.toBeNull();
        expect(result!.dependencies).toHaveLength(0);
        expect(result!.transformations).toHaveLength(0);
    });

    // ── static union stripping (_deep_strip_static_unions) ─────────────────

    it('strips a static-value UNION branch and traces only the real table', () => {
        // The right branch is all literals — should be stripped, leaving only orders.
        const sql = [
            'SELECT customer_id FROM orders',
            'UNION ALL',
            "SELECT 'placeholder' AS customer_id FROM (SELECT 1) AS dummy",
        ].join('\n');
        const result = traceV2(sql, 'customer_id');
        expect(result).not.toBeNull();
        expect(result!.dependencies).toContainEqual(
            expect.objectContaining({ column: 'customer_id', table: 'orders' }),
        );
        // The static branch (dummy) must not appear as a dependency
        expect(result!.dependencies.some(d => d.table === 'dummy')).toBe(false);
    });

    it('retains both tables when both UNION branches are real', () => {
        // Neither side is all-static — both should appear in dependencies.
        const sql = [
            'SELECT customer_id FROM orders',
            'UNION ALL',
            'SELECT customer_id FROM archive_orders',
        ].join('\n');
        const result = traceV2(sql, 'customer_id');
        expect(result).not.toBeNull();
        const tables = result!.dependencies.map(d => d.table);
        expect(tables).toContain('orders');
        expect(tables).toContain('archive_orders');
    });

    it('strips a static UNION inside a CTE and traces to the real upstream table', () => {
        // The CTE body has a static-branch union; after stripping only raw_orders remains.
        const sql = [
            'WITH base AS (',
            '    SELECT customer_id FROM raw_orders',
            '    UNION ALL',
            "    SELECT NULL AS customer_id FROM (SELECT 1) AS dummy",
            ')',
            'SELECT customer_id FROM base',
        ].join('\n');
        const result = traceV2(sql, 'customer_id');
        expect(result).not.toBeNull();
        expect(result!.dependencies).toContainEqual(
            expect.objectContaining({ column: 'customer_id', table: 'raw_orders' }),
        );
        expect(result!.dependencies.some(d => d.table === 'dummy')).toBe(false);
        expect(result!.via_ctes).toContain('base');
    });
});
