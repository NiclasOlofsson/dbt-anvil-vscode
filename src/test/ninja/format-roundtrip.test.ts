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

import { reflowDocument } from '../../ninja/reflow/engine';
import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';
import { PRESETS, type FormatPreset } from '../../ninja/presets';
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
		layout: {
			...DEFAULT_CONFIG.layout,
			...p.layout,
			alwaysWrap: { ...DEFAULT_CONFIG.layout.alwaysWrap, ...p.layout?.alwaysWrap },
		},
		convention: { ...DEFAULT_CONFIG.convention, ...p.convention },
		structure: { ...DEFAULT_CONFIG.structure, ...p.structure },
		maxLineLength: p.maxLineLength ?? DEFAULT_CONFIG.maxLineLength,
		maxBlankLines: p.maxBlankLines ?? DEFAULT_CONFIG.maxBlankLines,
	};
}

/**
 * Runs exactly the same pipeline as NinjaFormattingProvider:
 *   1. reflow (structural) if available
 *   2. surgical rule autofixes as a fallback
 *
 * Surgical-only filtering is explicit — structural rules still emit
 * FixAction for tests/code-actions, but the formatting path must never
 * apply them as point-edits. That's what the central `fixScope`
 * classification buys us.
 */
async function format(sql: string, config: NinjaConfig): Promise<string> {
	const [model, symbols] = await Promise.all([
		documentParser.parse(sql),
		documentParser.getDialectSymbols(),
	]);
	const doc = mockDocument(sql);
	const reflow = reflowDocument(doc, model, config, symbols);
	return reflow.edit ? reflow.edit.newText : sql;
}

/** Every *.in.sql in FIXTURES_DIR gets paired with a matching *.out.sql. */
const FIXTURES = fs.readdirSync(FIXTURES_DIR)
	.filter(f => f.endsWith('.in.sql'))
	.map(f => f.replace(/\.in\.sql$/, ''));

/**
 * A fixture can opt into a non-default preset by adding a sibling
 * `<name>.preset` file containing the preset name (e.g. `dbt-anvil`).
 * Absent → `sqlfmt`.
 */
function fixturePreset(name: string): FormatPreset {
	const presetPath = path.join(FIXTURES_DIR, `${name}.preset`);
	if (!fs.existsSync(presetPath)) return 'sqlfmt';
	const raw = fs.readFileSync(presetPath, 'utf8').trim();
	return raw as FormatPreset;
}

describe('Ninja formatter roundtrip', () => {
	beforeAll(async () => {
		const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
		documentParser = new FtlDocumentParser(PyodideSqlParser.create(runtime.pyodide), { adapterType: 'duckdb' });
	}, 60_000);

	for (const name of FIXTURES) {
		describe(name, () => {
			const inputPath    = path.join(FIXTURES_DIR, `${name}.in.sql`);
			const expectedPath = path.join(FIXTURES_DIR, `${name}.out.sql`);
			const actualPath   = path.join(FIXTURES_DIR, `${name}.actual.sql`);
			const config = buildConfig(fixturePreset(name));

			it('formats to match the expected output', async () => {
				const input    = fs.readFileSync(inputPath,    'utf8');
				const expected = fs.readFileSync(expectedPath, 'utf8');
				const actual   = await format(input, config);

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
