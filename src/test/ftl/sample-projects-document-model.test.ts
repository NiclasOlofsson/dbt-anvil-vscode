/**
 * Brute-force quantitative test: scan every .sql model file in the sample
 * projects and run each through FtlDocumentParser.parse() — the full
 * DocumentParser interface.  Fails if parse() throws; warns (but passes)
 * if no ctes/refs/sources/columns were extracted or sqlglot warnings fired.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { initPyodide } from '../../ftl/pyodide-loader';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser';
import { FtlDocumentParser } from '../../ftl/ftl-document-parser';

const SAMPLES_ROOT = path.join(__dirname, '..', '..', '..', 'samples');
const PYODIDE_DIR  = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR   = path.join(__dirname, '..', '..', '..', 'resources', 'bridge', 'vendor');
const SCRIPTS_DIR  = path.join(__dirname, '..', '..', '..', 'resources', 'ftl');

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

interface FileResult { label: string; warnings: string[] }
const RESULTS: FileResult[] = [];

let documentParser: FtlDocumentParser;

beforeAll(async () => {
    const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
    documentParser = new FtlDocumentParser(PyodideSqlParser.create(runtime.pyodide));
}, 60_000);

describe('sample project DocumentModel', () => {
    it('found SQL files to test', () => {
        expect(SQL_FILES.length).toBeGreaterThan(0);
        console.log(`Testing ${SQL_FILES.length} SQL files`);
    });

    for (const filePath of SQL_FILES) {
        const label = filePath.replace(SAMPLES_ROOT + path.sep, '').replaceAll('\\', '/');

        it(label, async () => {
            const raw    = fs.readFileSync(filePath, 'utf8');
            const model  = await documentParser.parse(raw, 'duckdb');

            const warnings = (model.sqlglotWarnings ?? []).map(w => w.message);

            if (warnings.length > 0) {
                for (const w of warnings) console.warn(`  [warning]  ${label}: ${w.split('\n')[0]}`);
            }

            RESULTS.push({ label, warnings });

            expect(Array.isArray(model.ctes)).toBe(true);
            expect(Array.isArray(model.refs)).toBe(true);
            expect(Array.isArray(model.sources)).toBe(true);
            expect(Array.isArray(model.finalColumns)).toBe(true);
            expect(Array.isArray(model.tokens)).toBe(true);
            expect(typeof model.timing.parseMs).toBe('number');
            expect(typeof model.timing.totalMs).toBe('number');
        });
    }

    it('summary', () => {
        const total    = RESULTS.length;
        const withWarn = RESULTS.filter(r => r.warnings.length > 0).length;
        console.log(`\nDocumentModel summary: ${total} files — ${withWarn} with sqlglot warnings`);
        for (const r of RESULTS.filter(r => r.warnings.length > 0)) {
            console.log(`  WARN  ${r.label}: ${r.warnings[0].split('\n')[0]}`);
        }
        expect(total).toBeGreaterThan(0);
    });
});

const STRESS_ITERATIONS = 50;

describe('sample project DocumentModel — stress (50 iterations)', () => {
    let poolParser: FtlDocumentParser;

    beforeAll(async () => {
        const cores = os.cpus().length;
        poolParser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, { minWorkers: cores, maxWorkers: cores });
        await poolParser.ready();
    }, 120_000);

    afterAll(() => {
        poolParser.dispose();
    });

    it(`parse all ${SQL_FILES.length} files × ${STRESS_ITERATIONS} iterations`, async () => {
        const sqlContents = SQL_FILES.map(f => fs.readFileSync(f, 'utf8'));
        const iterationMs: number[] = [];

        for (let i = 0; i < STRESS_ITERATIONS; i++) {
            const start = performance.now();
            await Promise.all(sqlContents.map(sql => poolParser.parse(sql, 'duckdb')));
            iterationMs.push(performance.now() - start);
        }

        const total  = iterationMs.reduce((a, b) => a + b, 0);
        const avg    = total / STRESS_ITERATIONS;
        const min    = Math.min(...iterationMs);
        const max    = Math.max(...iterationMs);
        const perFile = avg / SQL_FILES.length;

        console.log(`\nStress results (${SQL_FILES.length} files × ${STRESS_ITERATIONS} iterations):`);
        console.log(`  total   ${total.toFixed(0)}ms`);
        console.log(`  avg/run ${avg.toFixed(1)}ms`);
        console.log(`  min/run ${min.toFixed(1)}ms`);
        console.log(`  max/run ${max.toFixed(1)}ms`);
        console.log(`  avg/file ${perFile.toFixed(2)}ms`);

        expect(iterationMs.length).toBe(STRESS_ITERATIONS);
    }, 120_000);
});
