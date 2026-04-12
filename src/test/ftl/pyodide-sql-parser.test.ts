import * as path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';
import { initPyodide } from '../../ftl/pyodide-loader.js';
import type { PyodideRuntime } from '../../ftl/pyodide-loader.js';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser.js';
import { renToRawLine } from '../../ftl/nunjucks-renderer.js';

const PYODIDE_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'bridge', 'vendor');

let runtime: PyodideRuntime;
let parser: PyodideSqlParser;

beforeAll(async () => {
    runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR);
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

