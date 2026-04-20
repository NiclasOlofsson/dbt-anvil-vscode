/**
 * End-to-end formatter roundtrip test.
 *
 * Parses a representative "kitchen-sink" SQL file with the real Pyodide
 * sqlglot parser, runs it through the same pipeline as
 * NinjaFormattingProvider.provideDocumentFormattingEdits (minus the VS Code
 * config plumbing), and asserts the output matches a committed expected file.
 *
 * Also asserts idempotence — running the formatter twice produces the same
 * result as running it once, which catches rules whose fixes don't converge.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, beforeAll } from 'vitest';

import { initPyodide } from '../../ftl/pyodide-loader';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser';
import { FtlDocumentParser } from '../../ftl/ftl-document-parser';

import { runNinja } from '../../ninja/engine';
import { filterAutoFixViolations } from '../../providers/sql/formatting-provider';
import { planEdits } from '../../ninja/edit-planner';
import { applyFixGroups } from '../../ninja/reflow/applier';
import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';
import { PRESETS, type FormatPreset } from '../../ninja/presets';
import { tokenize } from '../../dbt/jinja-tokenizer';
import { mockDocument } from './helpers';

const PYODIDE_DIR = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR  = path.join(__dirname, '..', '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', '..', 'resources', 'ftl');
const FIXTURES_DIR = path.join(__dirname, 'fixtures', 'format');

let documentParser: FtlDocumentParser;

/**
 * Merge a named preset into DEFAULT_CONFIG so tests don't depend on
 * `loadConfig()` (which needs VS Code workspace.inspect, not in the mock).
 */
function buildConfig(preset: FormatPreset = 'sqlfmt'): NinjaConfig {
	const p = PRESETS[preset];
	return {
		...DEFAULT_CONFIG,
		format: { preset },
		capitalisation: { ...DEFAULT_CONFIG.capitalisation, ...p.capitalisation },
		indentation: { ...DEFAULT_CONFIG.indentation, ...p.indentation },
		layout: { ...DEFAULT_CONFIG.layout, ...p.layout },
		convention: { ...DEFAULT_CONFIG.convention, ...p.convention },
		structure: { ...DEFAULT_CONFIG.structure, ...p.structure },
		maxLineLength: p.maxLineLength ?? DEFAULT_CONFIG.maxLineLength,
		maxBlankLines: p.maxBlankLines ?? DEFAULT_CONFIG.maxBlankLines,
	};
}

async function formatOnce(sql: string, config: NinjaConfig): Promise<string> {
	const model = await documentParser.parse(sql);
	const doc = mockDocument(sql);
	const jinjaTokens = tokenize(sql);
	const result = runNinja(doc, model, jinjaTokens, config);
	const allowed = filterAutoFixViolations(result.violations, config);
	const planned = planEdits(allowed, doc);
	const edits = applyFixGroups(planned.groups, doc, config);
	return edits.length > 0 ? edits[0].newText : sql;
}

/**
 * Run the same pipeline as NinjaFormattingProvider, repeatedly until the
 * output stabilises. The edit planner's overlap-arbitration strategy
 * (`edit-planner.ts:59-61`) is explicit that convergence takes multiple
 * passes — losers drop and re-fire once the winner has converged.
 *
 * Capped at MAX_PASSES as a safety valve — anything exceeding that is a
 * genuine non-convergent rule interaction and the test should fail loudly.
 */
const MAX_PASSES = 5;
async function format(sql: string, config: NinjaConfig): Promise<string> {
	let text = sql;
	for (let i = 0; i < MAX_PASSES; i++) {
		const next = await formatOnce(text, config);
		if (next === text) return text;
		text = next;
	}
	throw new Error(`formatter did not converge in ${MAX_PASSES} passes`);
}

/** Every *.in.sql in FIXTURES_DIR gets paired with a matching *.out.sql. */
const FIXTURES = fs.readdirSync(FIXTURES_DIR)
	.filter(f => f.endsWith('.in.sql'))
	.map(f => f.replace(/\.in\.sql$/, ''));

describe('Ninja formatter roundtrip', () => {
	const config = buildConfig('sqlfmt');

	beforeAll(async () => {
		const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
		documentParser = new FtlDocumentParser(PyodideSqlParser.create(runtime.pyodide), { adapterType: 'duckdb' });
	}, 60_000);

	for (const name of FIXTURES) {
		describe(name, () => {
			const inputPath    = path.join(FIXTURES_DIR, `${name}.in.sql`);
			const expectedPath = path.join(FIXTURES_DIR, `${name}.out.sql`);
			const actualPath   = path.join(FIXTURES_DIR, `${name}.actual.sql`);

			it('formats to match the expected output', async () => {
				const input    = fs.readFileSync(inputPath,    'utf8');
				const expected = fs.readFileSync(expectedPath, 'utf8');
				const actual   = await format(input, config);

				// Drop a sibling .actual.sql on mismatch so diffs are easy to inspect.
				if (actual !== expected) {
					fs.writeFileSync(actualPath, actual, 'utf8');
				} else if (fs.existsSync(actualPath)) {
					fs.unlinkSync(actualPath);
				}
				expect(actual).toBe(expected);
			});

			it('is idempotent (format twice = format once)', async () => {
				const input = fs.readFileSync(inputPath, 'utf8');
				const once  = await format(input, config);
				const twice = await format(once,  config);
				expect(twice).toBe(once);
			});
		});
	}
});
