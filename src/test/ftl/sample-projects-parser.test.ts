/**
 * Brute-force quantitative test: scan every .sql model file in the sample
 * projects, blank Jinja, then run through PyodideSqlParser.  Fails if the
 * parser throws; warns (but passes) if ast is empty or warnings are present.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';
import { initPyodide } from '../../ftl/pyodide-loader';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser';

const SAMPLES_ROOT = path.join(__dirname, '..', '..', '..', 'samples');
const PYODIDE_DIR  = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR   = path.join(__dirname, '..', '..', '..', 'resources', 'bridge', 'vendor');

function collectSqlFiles(dir: string): string[] {
    const results: string[] = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...collectSqlFiles(full));
        } else if (entry.isFile() && entry.name.endsWith('.sql')) {
            results.push(full);
        }
    }
    return results;
}

const MODEL_DIRS = [
    path.join(SAMPLES_ROOT, 'jaffle_shop', 'models'),
    path.join(SAMPLES_ROOT, 'nba-monte-carlo', 'models'),
];

const SQL_FILES = MODEL_DIRS.flatMap(d => (fs.existsSync(d) ? collectSqlFiles(d) : []));

interface FileResult { label: string; ok: boolean; emptyAst: boolean; warnings: string[] }
const RESULTS: FileResult[] = [];

let parser: PyodideSqlParser;

beforeAll(async () => {
    const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR);
    parser = PyodideSqlParser.create(runtime.pyodide);
}, 60_000);

describe('sample project SQL files', () => {
    it('found SQL files to test', () => {
        expect(SQL_FILES.length).toBeGreaterThan(0);
        console.log(`Testing ${SQL_FILES.length} SQL files`);
    });

    for (const filePath of SQL_FILES) {
        const label = filePath.replace(SAMPLES_ROOT + path.sep, '').replaceAll('\\', '/');

        it(label, async () => {
            const raw     = fs.readFileSync(filePath, 'utf8');
            const result  = await parser.parse(raw, 'duckdb');

            const emptyAst = result.ast.length === 0;
            const warnings = result.warnings.map(w => w.message);

            if (emptyAst) console.warn(`  [empty ast]  ${label}`);
            for (const w of warnings) console.warn(`  [warning]    ${label}: ${w.split('\n')[0]}`);

            RESULTS.push({ label, ok: !emptyAst || warnings.length === 0, emptyAst, warnings });

            expect(Array.isArray(result.ast)).toBe(true);
            expect(Array.isArray(result.scopes)).toBe(true);
            expect(typeof result.timing.totalMs).toBe('number');
        });
    }

    it('summary', () => {
        const total    = RESULTS.length;
        const withAst  = RESULTS.filter(r => !r.emptyAst).length;
        const withWarn = RESULTS.filter(r => r.warnings.length > 0).length;
        console.log(`\nParse summary: ${total} files — ${withAst} with AST, ${withWarn} with parse warnings`);
        for (const r of RESULTS.filter(r => r.warnings.length > 0)) {
            console.log(`  WARN  ${r.label}: ${r.warnings[0].split('\n')[0]}`);
        }
        expect(total).toBeGreaterThan(0);
    });
});

