import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

import { initPyodide } from '../../ftl/pyodide-loader';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser';
import { FtlDocumentParser } from '../../ftl/ftl-document-parser';
import { runNinja, getRuleFixScopeById, getAllRuleMetadata } from '../../ninja/engine';
import { tokenize as tokenizeJinja } from '../../dbt/jinja-tokenizer';
import { reflowDocument } from '../../ninja/reflow/engine';
import { mockDocument } from './helpers';
import { discoverFixtures, type Fixture } from './fixture-loader';

const PYODIDE_DIR   = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR    = path.join(__dirname, '..', '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR   = path.join(__dirname, '..', '..', '..', 'resources', 'ftl');
const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'rules');

let documentParser: FtlDocumentParser;

beforeAll(async () => {
	const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
	documentParser = new FtlDocumentParser(PyodideSqlParser.create(runtime.pyodide), { adapterType: 'duckdb' });
}, 60_000);

describe('rule parity harness', () => {
	const fixtures = discoverFixtures(FIXTURES_ROOT);

	if (fixtures.length === 0) {
		it('no fixtures yet', () => {
			// Intentional placeholder so the suite doesn't report "no tests".
		});
		return;
	}

	for (const fx of fixtures) {
		const label = fx.variantName ? `${fx.ruleId} [${fx.variantName}]` : fx.ruleId;
		it(label, async () => {
			await runFixture(fx);
		});
	}
});

/**
 * Every structural rule MUST have at least one fixture directory (bare or
 * variant) under `src/test/ninja/fixtures/rules/`. Skipped until the initial
 * rollout is complete — re-enable when adding the last structural rule's
 * fixture so this becomes the gate against future drift.
 */
describe.skip('structural rule completeness', () => {
	const structuralRuleIds = getAllRuleMetadata()
		.filter(r => r.fixScope === 'structural')
		.map(r => r.id);
	const present = new Set(discoverFixtures(FIXTURES_ROOT).map(f => f.ruleId));

	for (const ruleId of structuralRuleIds) {
		it(`${ruleId} has at least one fixture`, () => {
			expect(present.has(ruleId), `Missing fixture directory: src/test/ninja/fixtures/rules/${ruleId}/`).toBe(true);
		});
	}
});

async function runFixture(fx: Fixture): Promise<void> {
	const symbols = await documentParser.getDialectSymbols();

	// Assertion 1: rule fires on violation
	const violationModel  = await documentParser.parse(fx.violation);
	const violationDoc    = mockDocument(fx.violation);
	const violationResult = runNinja(violationDoc, violationModel, tokenizeJinja(fx.violation), fx.config, symbols);
	const targetViolations = violationResult.violations.filter(v => v.rule === fx.ruleId);
	expect(targetViolations.length, `assertion 1: ${fx.ruleId} should fire on violation.sql`).toBeGreaterThanOrEqual(1);

	// Assertion 2: formatter produces expected
	const reflow = reflowDocument(violationDoc, violationModel, fx.config, symbols);
	expect(
		reflow.edit,
		`assertion 2 prereq: reflowDocument returned null (reason: ${reflow.reason ?? 'unknown'}) — check model/tokens`,
	).not.toBeNull();
	const formatted = reflow.edit!.newText;
	expect(formatted, `assertion 2: format(violation.sql) === expected.sql`).toBe(fx.expected);

	// Assertion 3: rule clean on expected
	const expectedModel  = await documentParser.parse(fx.expected);
	const expectedDoc    = mockDocument(fx.expected);
	const expectedResult = runNinja(expectedDoc, expectedModel, tokenizeJinja(fx.expected), fx.config, symbols);
	const expectedViolations = expectedResult.violations.filter(v => v.rule === fx.ruleId);
	expect(expectedViolations.length, `assertion 3: ${fx.ruleId} should not fire on expected.sql`).toBe(0);

	// Assertion 4: full lint clean on formatter output (every structural rule)
	const outputModel  = await documentParser.parse(formatted);
	const outputDoc    = mockDocument(formatted);
	const outputResult = runNinja(outputDoc, outputModel, tokenizeJinja(formatted), fx.config, symbols);
	const structural = outputResult.violations.filter(v => getRuleFixScopeById(v.rule) === 'structural');
	expect(structural.map(v => v.rule), `assertion 4: structural rules must be clean on formatter output`).toEqual([]);
}
