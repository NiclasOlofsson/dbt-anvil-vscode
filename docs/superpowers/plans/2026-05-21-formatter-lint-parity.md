# Formatter / Linter Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a fixture-driven harness that guarantees every structural rule and the formatter agree on the canonical form, then drive the formatter and rules to consistency one rule at a time.

**Architecture:** A new parity-test harness reads hand-crafted `violation.sql` / `expected.sql` pairs from `src/test/ninja/fixtures/rules/<rule-id>/`, parses both with Pyodide sqlglot, lints them through `runNinja`, formats `violation.sql` through `reflowDocument`, and asserts four invariants (rule fires on broken input, formatter produces expected, expected is canonical, full lint clean on formatter output). A second test runs the same contract over real dbt models under `samples/`.

**Tech Stack:** TypeScript, vitest, Pyodide (sqlglot WASM), existing `FtlDocumentParser`, existing `runNinja`/`reflowDocument` engines.

**Spec:** [docs/superpowers/specs/2026-05-21-formatter-lint-parity-design.md](../specs/2026-05-21-formatter-lint-parity-design.md)

---

## Task 1: Fixture loader

**Files:**
- Create: `src/test/ninja/fixture-loader.ts`
- Create: `src/test/ninja/fixtures/rules/.gitkeep`
- Test: `src/test/ninja/fixture-loader.test.ts`

The loader discovers fixture directories under a root, reads `violation.sql` + `expected.sql`, and deep-merges any `config.json` over `DEFAULT_CONFIG`.

- [ ] **Step 1: Create empty fixtures root**

```bash
mkdir -p src/test/ninja/fixtures/rules
touch src/test/ninja/fixtures/rules/.gitkeep
```

- [ ] **Step 2: Write the failing tests**

Create `src/test/ninja/fixture-loader.test.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { discoverFixtures, loadFixture } from './fixture-loader';
import { DEFAULT_CONFIG } from '../../ninja/config';

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-loader-'));
});
afterEach(() => {
	fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeFixture(dir: string, files: Record<string, string>): void {
	fs.mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		fs.writeFileSync(path.join(dir, name), content, 'utf8');
	}
}

describe('fixture-loader', () => {
	it('loads a bare fixture (violation.sql + expected.sql, no config.json)', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, {
			'violation.sql': 'select 1',
			'expected.sql': 'select 1\n',
		});
		const fx = loadFixture(dir);
		expect(fx.ruleId).toBe('ninja.example.rule');
		expect(fx.variantName).toBeUndefined();
		expect(fx.violation).toBe('select 1');
		expect(fx.expected).toBe('select 1\n');
		expect(fx.config).toEqual(DEFAULT_CONFIG);
	});

	it('deep-merges config.json over DEFAULT_CONFIG', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, {
			'violation.sql': 'x',
			'expected.sql': 'x',
			'config.json': JSON.stringify({ layout: { commaPosition: 'leading' } }),
		});
		const fx = loadFixture(dir);
		expect(fx.config.layout.commaPosition).toBe('leading');
		// Other layout keys preserved from default
		expect(fx.config.layout.operatorPosition).toBe(DEFAULT_CONFIG.layout.operatorPosition);
	});

	it('throws when violation.sql is missing', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, { 'expected.sql': 'x' });
		expect(() => loadFixture(dir)).toThrow(/violation\.sql/);
	});

	it('throws when expected.sql is missing', () => {
		const dir = path.join(tmpRoot, 'ninja.example.rule');
		writeFixture(dir, { 'violation.sql': 'x' });
		expect(() => loadFixture(dir)).toThrow(/expected\.sql/);
	});

	it('discoverFixtures returns one fixture per bare rule directory', () => {
		const dir = path.join(tmpRoot, 'ninja.a');
		writeFixture(dir, { 'violation.sql': 'x', 'expected.sql': 'x' });
		const out = discoverFixtures(tmpRoot);
		expect(out).toHaveLength(1);
		expect(out[0].ruleId).toBe('ninja.a');
	});

	it('discoverFixtures expands shape subdirectories', () => {
		const ruleDir = path.join(tmpRoot, 'ninja.b');
		writeFixture(path.join(ruleDir, '01-close-paren'), { 'violation.sql': 'x', 'expected.sql': 'x' });
		writeFixture(path.join(ruleDir, '02-open-paren'),  { 'violation.sql': 'x', 'expected.sql': 'x' });
		const out = discoverFixtures(tmpRoot).filter(f => f.ruleId === 'ninja.b');
		expect(out).toHaveLength(2);
		expect(out.map(f => f.variantName).sort()).toEqual(['01-close-paren', '02-open-paren']);
	});

	it('discoverFixtures allows bare fixture AND shape subdirectories side by side', () => {
		const ruleDir = path.join(tmpRoot, 'ninja.c');
		writeFixture(ruleDir, { 'violation.sql': 'x', 'expected.sql': 'x' });
		writeFixture(path.join(ruleDir, '01-extra'), { 'violation.sql': 'x', 'expected.sql': 'x' });
		const out = discoverFixtures(tmpRoot).filter(f => f.ruleId === 'ninja.c');
		expect(out).toHaveLength(2);
		expect(out.map(f => f.variantName).sort()).toEqual([undefined, '01-extra'] as any);
	});
});
```

- [ ] **Step 3: Run the failing tests**

Run: `npx vitest run src/test/ninja/fixture-loader.test.ts`
Expected: FAIL — `Cannot find module './fixture-loader'`

- [ ] **Step 4: Implement the loader**

Create `src/test/ninja/fixture-loader.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';

export interface Fixture {
	/** The rule id this fixture exercises, taken from the directory name. */
	ruleId: string;
	/** Subdirectory name for shape variants, or undefined for the bare fixture. */
	variantName?: string;
	/** Absolute path of the fixture's leaf directory. */
	dir: string;
	/** Raw text of violation.sql. */
	violation: string;
	/** Raw text of expected.sql. */
	expected: string;
	/** DEFAULT_CONFIG deep-merged with any config.json present. */
	config: NinjaConfig;
}

/**
 * Read a single fixture from a leaf directory. The directory MUST contain
 * `violation.sql` and `expected.sql`; `config.json` is optional.
 *
 * `ruleId` and `variantName` are inferred from the path. When `dir` sits one
 * level below the rules root the parent name is the rule id and the leaf name
 * is the variant; when it sits at the rules root the leaf name is the rule id
 * and there is no variant.
 *
 * The caller supplies `ruleId` / `variantName` so callers that have already
 * walked the tree don't re-derive them. Used both by `discoverFixtures` and
 * by tests that want a single fixture by path.
 */
export function loadFixture(dir: string, ruleId?: string, variantName?: string): Fixture {
	const violationPath = path.join(dir, 'violation.sql');
	const expectedPath  = path.join(dir, 'expected.sql');
	const configPath    = path.join(dir, 'config.json');

	if (!fs.existsSync(violationPath)) {
		throw new Error(`fixture ${dir}: missing violation.sql`);
	}
	if (!fs.existsSync(expectedPath)) {
		throw new Error(`fixture ${dir}: missing expected.sql`);
	}

	const violation = fs.readFileSync(violationPath, 'utf8');
	const expected  = fs.readFileSync(expectedPath,  'utf8');

	let config = DEFAULT_CONFIG;
	if (fs.existsSync(configPath)) {
		const override = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Partial<NinjaConfig>;
		config = deepMerge(DEFAULT_CONFIG, override) as NinjaConfig;
	}

	const inferredRuleId = ruleId ?? path.basename(dir);
	return { ruleId: inferredRuleId, variantName, dir, violation, expected, config };
}

/**
 * Walk `rootDir` for fixture leaves. A child directory of `rootDir` is either
 * a bare fixture (contains violation.sql at top) or a shape-variant container
 * (each subdirectory is its own fixture), or both (a bare fixture beside
 * shape subdirectories — the loader emits one bare entry and one per variant).
 */
export function discoverFixtures(rootDir: string): Fixture[] {
	if (!fs.existsSync(rootDir)) return [];
	const out: Fixture[] = [];
	for (const ruleName of fs.readdirSync(rootDir).sort()) {
		const ruleDir = path.join(rootDir, ruleName);
		if (!fs.statSync(ruleDir).isDirectory()) continue;

		const hasBareViolation = fs.existsSync(path.join(ruleDir, 'violation.sql'));
		if (hasBareViolation) {
			out.push(loadFixture(ruleDir, ruleName, undefined));
		}
		for (const child of fs.readdirSync(ruleDir).sort()) {
			const childDir = path.join(ruleDir, child);
			if (!fs.statSync(childDir).isDirectory()) continue;
			if (!fs.existsSync(path.join(childDir, 'violation.sql'))) continue;
			out.push(loadFixture(childDir, ruleName, child));
		}
	}
	return out;
}

/**
 * Recursive deep merge for plain JSON objects. Override wins on scalars and
 * arrays; objects are merged key-by-key. Sufficient for NinjaConfig shape.
 */
function deepMerge(base: unknown, override: unknown): unknown {
	if (override === undefined) return base;
	if (typeof base !== 'object' || base === null || Array.isArray(base)) return override;
	if (typeof override !== 'object' || override === null || Array.isArray(override)) return override;
	const result: Record<string, unknown> = { ...(base as Record<string, unknown>) };
	for (const key of Object.keys(override as Record<string, unknown>)) {
		result[key] = deepMerge((base as Record<string, unknown>)[key], (override as Record<string, unknown>)[key]);
	}
	return result;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/test/ninja/fixture-loader.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 6: Commit**

```bash
git add src/test/ninja/fixture-loader.ts src/test/ninja/fixture-loader.test.ts src/test/ninja/fixtures/rules/.gitkeep
git commit -m "test(ninja): add fixture loader for formatter/linter parity harness"
```

---

## Task 2: Parity harness — single fixture, four assertions

**Files:**
- Create: `src/test/ninja/rule-parity.test.ts`
- Create: `src/test/ninja/fixtures/rules/ninja.layout.trailing-newline/violation.sql`
- Create: `src/test/ninja/fixtures/rules/ninja.layout.trailing-newline/expected.sql`

We need ONE fixture that the formatter and linter already agree on, to validate the harness pipeline end-to-end before scaling. `ninja.layout.trailing-newline` is the simplest candidate — the formatter unconditionally adds a trailing newline at [src/ninja/reflow/engine.ts](../../../src/ninja/reflow/engine.ts) end-of-file, and the rule fires when the trailing newline is absent.

- [ ] **Step 1: Write the sanity fixture**

Create the fixture directory and files using `printf` so the byte content is exact — editors will silently add trailing newlines and break the test.

```bash
mkdir -p src/test/ninja/fixtures/rules/ninja.layout.trailing-newline
printf 'select 1'   > src/test/ninja/fixtures/rules/ninja.layout.trailing-newline/violation.sql
printf 'select 1\n' > src/test/ninja/fixtures/rules/ninja.layout.trailing-newline/expected.sql
```

Verify byte sizes differ by exactly 1:

```bash
wc -c src/test/ninja/fixtures/rules/ninja.layout.trailing-newline/violation.sql src/test/ninja/fixtures/rules/ninja.layout.trailing-newline/expected.sql
```

Expected: violation.sql is 8 bytes, expected.sql is 9 bytes.

- [ ] **Step 2: Write the failing harness test**

Create `src/test/ninja/rule-parity.test.ts`:

```typescript
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

import { initPyodide } from '../../ftl/pyodide-loader';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser';
import { FtlDocumentParser } from '../../ftl/ftl-document-parser';
import { runNinja } from '../../ninja/engine';
import { reflowDocument } from '../../ninja/reflow/engine';
import { getRuleFixScopeById } from '../../ninja/engine';
import { mockDocument } from './helpers';
import { loadFixture, type Fixture } from './fixture-loader';

const PYODIDE_DIR  = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR   = path.join(__dirname, '..', '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR  = path.join(__dirname, '..', '..', '..', 'resources', 'ftl');
const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'rules');

let documentParser: FtlDocumentParser;

beforeAll(async () => {
	const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
	documentParser = new FtlDocumentParser(PyodideSqlParser.create(runtime.pyodide), { adapterType: 'duckdb' });
}, 60_000);

describe('rule parity harness', () => {
	it('trailing-newline fixture passes all four assertions', async () => {
		const fx = loadFixture(path.join(FIXTURES_ROOT, 'ninja.layout.trailing-newline'));
		await runFixture(fx);
	});
});

async function runFixture(fx: Fixture): Promise<void> {
	const symbols = await documentParser.getDialectSymbols();

	// Assertion 1: rule fires on violation
	const violationModel  = await documentParser.parse(fx.violation);
	const violationDoc    = mockDocument(fx.violation);
	const violationResult = runNinja(violationDoc, violationModel, violationModel.jinjaTokens ?? [], fx.config, symbols);
	const targetViolations = violationResult.violations.filter(v => v.rule === fx.ruleId);
	expect(targetViolations.length, `assertion 1: ${fx.ruleId} should fire on violation.sql`).toBeGreaterThanOrEqual(1);

	// Assertion 2: formatter produces expected
	const reflow = reflowDocument(violationDoc, violationModel, fx.config, symbols);
	const formatted = reflow.edit ? reflow.edit.newText : fx.violation;
	expect(formatted, `assertion 2: format(violation.sql) === expected.sql`).toBe(fx.expected);

	// Assertion 3: rule clean on expected
	const expectedModel  = await documentParser.parse(fx.expected);
	const expectedDoc    = mockDocument(fx.expected);
	const expectedResult = runNinja(expectedDoc, expectedModel, expectedModel.jinjaTokens ?? [], fx.config, symbols);
	const expectedViolations = expectedResult.violations.filter(v => v.rule === fx.ruleId);
	expect(expectedViolations.length, `assertion 3: ${fx.ruleId} should not fire on expected.sql`).toBe(0);

	// Assertion 4: full lint clean on formatter output (every structural rule)
	const outputModel  = await documentParser.parse(formatted);
	const outputDoc    = mockDocument(formatted);
	const outputResult = runNinja(outputDoc, outputModel, outputModel.jinjaTokens ?? [], fx.config, symbols);
	const structural = outputResult.violations.filter(v => getRuleFixScopeById(v.rule) === 'structural');
	expect(structural.map(v => v.rule), `assertion 4: structural rules must be clean on formatter output`).toEqual([]);
}
```

(The placeholder `lint` function exists only to keep the import chain compiling; the test body doesn't call it. Remove it in Step 4.)

- [ ] **Step 3: Run to verify it fails**

Run: `npx vitest run src/test/ninja/rule-parity.test.ts`
Expected: depends on whether the trailing-newline rule and formatter already agree. Either way, the failure mode is informative — that's the point.

- [ ] **Step 4: Fix any failures**

If assertion 1 fails: investigate `src/ninja/rules/layout-trailing-newline.ts` — it should fire when source doesn't end with `\n`.

If assertion 2 fails: the formatter's end-of-output normalisation is at [src/ninja/reflow/printer.ts](../../../src/ninja/reflow/printer.ts) near the bottom (`output += '\n'`). Verify it runs.

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/test/ninja/rule-parity.test.ts`
Expected: PASS — 1 test.

- [ ] **Step 6: Commit**

```bash
git add src/test/ninja/rule-parity.test.ts src/test/ninja/fixtures/rules/ninja.layout.trailing-newline/
git commit -m "test(ninja): parity harness with first fixture (trailing-newline)"
```

---

## Task 3: Parameterise harness over all discovered fixtures

**Files:**
- Modify: `src/test/ninja/rule-parity.test.ts`

Replace the hand-written single test with a loop over `discoverFixtures`.

- [ ] **Step 1: Update the describe block to iterate**

Edit `src/test/ninja/rule-parity.test.ts`. Replace the `describe('rule parity harness', ...)` block with:

```typescript
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
```

- [ ] **Step 2: Run to verify the existing fixture still passes via the loop**

Run: `npx vitest run src/test/ninja/rule-parity.test.ts`
Expected: PASS — 1 test labelled `ninja.layout.trailing-newline`.

- [ ] **Step 3: Commit**

```bash
git add src/test/ninja/rule-parity.test.ts
git commit -m "test(ninja): parameterise parity harness over discovered fixtures"
```

---

## Task 4: Rule-completeness check (kept skipped until cutover)

**Files:**
- Modify: `src/test/ninja/rule-parity.test.ts`

The check enumerates structural rules and asserts each has at least one fixture. Initially `.skip` because we haven't written the fixtures yet — re-enabled in Task 10.

- [ ] **Step 1: Add the completeness test**

In `src/test/ninja/rule-parity.test.ts`, after the parameterised describe block, append:

```typescript
import { getAllRuleMetadata } from '../../ninja/engine';

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
```

- [ ] **Step 2: Run to verify it's skipped, not failing**

Run: `npx vitest run src/test/ninja/rule-parity.test.ts`
Expected: PASS overall; "structural rule completeness" appears as skipped.

- [ ] **Step 3: Commit**

```bash
git add src/test/ninja/rule-parity.test.ts
git commit -m "test(ninja): add structural-rule completeness check (skipped until cutover)"
```

---

## Task 5: Corpus parity test

**Files:**
- Create: `src/test/ninja/corpus-parity.test.ts`

Runs the formatter+lint contract over every `*.sql` under `samples/*/models/`. No golden file — just asserts lint-clean on formatter output.

- [ ] **Step 1: Write the corpus test**

Create `src/test/ninja/corpus-parity.test.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect, beforeAll } from 'vitest';

import { initPyodide } from '../../ftl/pyodide-loader';
import { PyodideSqlParser } from '../../ftl/pyodide-sql-parser';
import { FtlDocumentParser } from '../../ftl/ftl-document-parser';
import { runNinja, getRuleFixScopeById } from '../../ninja/engine';
import { reflowDocument } from '../../ninja/reflow/engine';
import { DEFAULT_CONFIG } from '../../ninja/config';
import { mockDocument } from './helpers';

const PYODIDE_DIR  = path.join(__dirname, '..', '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR   = path.join(__dirname, '..', '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR  = path.join(__dirname, '..', '..', '..', 'resources', 'ftl');
const SAMPLES_ROOT = path.join(__dirname, '..', '..', '..', 'samples');

let documentParser: FtlDocumentParser;

beforeAll(async () => {
	const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
	documentParser = new FtlDocumentParser(PyodideSqlParser.create(runtime.pyodide), { adapterType: 'duckdb' });
}, 60_000);

function findModelFiles(): string[] {
	const out: string[] = [];
	if (!fs.existsSync(SAMPLES_ROOT)) return out;
	for (const project of fs.readdirSync(SAMPLES_ROOT)) {
		const modelsDir = path.join(SAMPLES_ROOT, project, 'models');
		if (!fs.existsSync(modelsDir)) continue;
		walk(modelsDir, out);
	}
	return out;
}

function walk(dir: string, acc: string[]): void {
	for (const entry of fs.readdirSync(dir)) {
		const full = path.join(dir, entry);
		const stat = fs.statSync(full);
		if (stat.isDirectory()) walk(full, acc);
		else if (entry.endsWith('.sql')) acc.push(full);
	}
}

describe('corpus parity', () => {
	const files = findModelFiles();

	if (files.length === 0) {
		it('no sample models found', () => {
			// Skip when samples are absent (e.g. CI without sample data).
		});
		return;
	}

	for (const file of files) {
		const label = path.relative(SAMPLES_ROOT, file);
		it(`formatter output is lint-clean: ${label}`, async () => {
			const sql = fs.readFileSync(file, 'utf8');
			const symbols = await documentParser.getDialectSymbols();
			const violationModel = await documentParser.parse(sql);
			const violationDoc   = mockDocument(sql);
			const reflow = reflowDocument(violationDoc, violationModel, DEFAULT_CONFIG, symbols);
			const formatted = reflow.edit ? reflow.edit.newText : sql;

			const outputModel = await documentParser.parse(formatted);
			const outputDoc   = mockDocument(formatted);
			const outputResult = runNinja(outputDoc, outputModel, outputModel.jinjaTokens ?? [], DEFAULT_CONFIG, symbols);
			const structural = outputResult.violations.filter(v => getRuleFixScopeById(v.rule) === 'structural');

			expect(
				structural.map(v => `${v.rule}@${v.range.start.line + 1}:${v.range.start.character + 1}`),
				`structural rules must be clean on formatter output of ${label}`,
			).toEqual([]);
		});
	}
});
```

- [ ] **Step 2: Run the corpus test**

Run: `npx vitest run src/test/ninja/corpus-parity.test.ts`
Expected: FAIL on most sample files — this is the bug surface from the spec. Each failure prints a list of structural rule violations and locations. **Do not fix yet.** This is the work list for Tasks 7+.

- [ ] **Step 3: Wrap in `describe.skip` for now**

The corpus test will be red until enough per-rule fixtures land to clean the formatter output. Skip it for now to keep the harness PR green; Task 10 flips it back on.

Wrap the entire `describe('corpus parity', ...)` block with `.skip`:

```typescript
describe.skip('corpus parity', () => {
```

- [ ] **Step 4: Commit**

```bash
git add src/test/ninja/corpus-parity.test.ts
git commit -m "test(ninja): add corpus parity test (skipped until structural rule cutover)"
```

---

## Task 6: First TDD rule — `ninja.layout.cte-bracket`

**Files:**
- Create: `src/test/ninja/fixtures/rules/ninja.layout.cte-bracket/violation.sql`
- Create: `src/test/ninja/fixtures/rules/ninja.layout.cte-bracket/expected.sql`
- Likely modify: `src/ninja/reflow/printer.ts`
- Possibly modify: `src/ninja/rules/layout-cte-bracket.ts`

This is the worked example for the TDD loop. The real-world bug is that `), next_cte as (` collapses onto one line. The canonical form per the rule's definition is: closing `)`, comma, then `next_cte as (` on a new line at the outer indent.

- [ ] **Step 1: Read the rule to confirm its canonical form**

```bash
cat src/ninja/rules/layout-cte-bracket.ts
```

Note the exact prescription — the rule's `check()` function is the authoritative spec for what's a violation. Use it to write the canonical `expected.sql`.

- [ ] **Step 2: Write fixtures**

Create `src/test/ninja/fixtures/rules/ninja.layout.cte-bracket/violation.sql`:

```sql
with a as (
    select 1 as x
), b as (
    select 2 as x
)
select * from a join b on a.x = b.x
```

Create `src/test/ninja/fixtures/rules/ninja.layout.cte-bracket/expected.sql` — write what the rule itself says is canonical. The most likely form (verify against the rule source):

```sql
with a as (
    select 1 as x
),

b as (
    select 2 as x
)

select *
from a
join b on a.x = b.x
```

(The blank line between CTEs is `cte-blank-line`'s territory. If `cte-bracket` doesn't prescribe the blank line, omit it here and let Task 7 add it under its own fixture.)

- [ ] **Step 3: Run the harness, observe failures**

Run: `npx vitest run src/test/ninja/rule-parity.test.ts -t "cte-bracket"`
Expected: at least one assertion fails. Note which:
- **Assertion 1 fail** → rule doesn't fire on `violation.sql`. The detector is too narrow. Fix in `src/ninja/rules/layout-cte-bracket.ts`.
- **Assertion 2 fail** → formatter output doesn't match. Look at the diff. Fix in `src/ninja/reflow/printer.ts` (`parenClosesIndent` / `isCteSeparatorComma` paths) and/or `src/ninja/reflow/indent-policy.ts`.
- **Assertion 3 fail** → your hand-written `expected.sql` still trips the rule. Re-read the rule.
- **Assertion 4 fail** → another structural rule complains about your `expected.sql`. The failure message names it. Either refine `expected.sql` to satisfy both rules, or refine one of the rules.

- [ ] **Step 4: Iterate fix → run → fix until green**

This is real TDD work. Reference points in the code:

- CTE separator comma logic: [src/ninja/reflow/printer.ts:357-361](../../../src/ninja/reflow/printer.ts#L357-L361) and [src/ninja/reflow/printer.ts:448-456](../../../src/ninja/reflow/printer.ts#L448-L456).
- Indenting paren open/close: [src/ninja/reflow/printer.ts:257-270](../../../src/ninja/reflow/printer.ts#L257-L270).
- Indent policy: [src/ninja/reflow/indent-policy.ts](../../../src/ninja/reflow/indent-policy.ts).
- Rule check: `src/ninja/rules/layout-cte-bracket.ts`.

After each edit:

```bash
npx vitest run src/test/ninja/rule-parity.test.ts -t "cte-bracket"
```

Stop when all four assertions pass.

- [ ] **Step 5: Sanity — full ninja suite still green**

Run: `npx vitest run src/test/ninja/`
Expected: every test still passes (the existing 818 + the new harness tests). If any existing test now fails, the fix changed behavior that another test relied on. Reconcile by either refining the fix or updating the now-outdated test.

- [ ] **Step 6: Commit**

```bash
git add src/test/ninja/fixtures/rules/ninja.layout.cte-bracket/ src/ninja/reflow/ src/ninja/rules/layout-cte-bracket.ts
git commit -m "fix(ninja): parity for layout.cte-bracket"
```

---

## Task 7: Apply the same loop to `ninja.layout.cte-blank-line`

**Files:**
- Create: `src/test/ninja/fixtures/rules/ninja.layout.cte-blank-line/violation.sql`
- Create: `src/test/ninja/fixtures/rules/ninja.layout.cte-blank-line/expected.sql`
- Likely modify: `src/ninja/reflow/printer.ts`, possibly `src/ninja/rules/layout-cte-blank-line.ts`

- [ ] **Step 1: Read the rule**

```bash
cat src/ninja/rules/layout-cte-blank-line.ts
```

- [ ] **Step 2: Write fixtures**

`violation.sql` (no blank line between CTEs):

```sql
with a as (
    select 1
),
b as (
    select 2
)
select * from a, b
```

`expected.sql` (blank line between CTEs — adjust to match rule's exact prescription):

```sql
with a as (
    select 1
),

b as (
    select 2
)

select *
from a, b
```

- [ ] **Step 3: Run, observe, iterate**

```bash
npx vitest run src/test/ninja/rule-parity.test.ts -t "cte-blank-line"
```

Iterate as in Task 6 until all four assertions pass.

- [ ] **Step 4: Sanity full suite**

```bash
npx vitest run src/test/ninja/
```

- [ ] **Step 5: Commit**

```bash
git add src/test/ninja/fixtures/rules/ninja.layout.cte-blank-line/ src/ninja/reflow/ src/ninja/rules/layout-cte-blank-line.ts
git commit -m "fix(ninja): parity for layout.cte-blank-line"
```

---

## Task 8: Apply the loop to `ninja.layout.indent-bracket` (IN-list vs subquery)

**Files:**
- Create: `src/test/ninja/fixtures/rules/ninja.layout.indent-bracket/violation.sql`
- Create: `src/test/ninja/fixtures/rules/ninja.layout.indent-bracket/expected.sql`
- Likely modify: `src/ninja/reflow/printer.ts:257-264` (the `parenOpensIndent` logic), or split into a shape-variant fixture if both `IN` and subquery cases need testing.

This rule is where the IN-list-treated-as-subquery bug lives. The printer at [src/ninja/reflow/printer.ts:262](../../../src/ninja/reflow/printer.ts#L262) sets `parenOpensIndent` when `prevTypeUpper === 'IN'`, which is wrong for scalar IN lists.

- [ ] **Step 1: Read the rule**

```bash
cat src/ninja/rules/layout-indent-bracket.ts
```

- [ ] **Step 2: Decide whether to use shape variants**

If `indent-bracket` covers BOTH subquery indent and IN-list non-indent in one rule, use a shape-variant layout:

```
ninja.layout.indent-bracket/
  01-in-list-scalar/
    violation.sql, expected.sql
  02-in-subquery/
    violation.sql, expected.sql
```

Otherwise a single fixture is fine.

- [ ] **Step 3: Write fixtures**

For `01-in-list-scalar/violation.sql`:

```sql
select *
from t
where status in ('a', 'b', 'c')
```

For `01-in-list-scalar/expected.sql` (no indent, IN-list stays inline):

```sql
select *
from t
where status in ('a', 'b', 'c')
```

(If the formatter currently mangles this, `violation.sql` and `expected.sql` look identical — that's fine. Assertion 1 still requires the rule to fire on `violation.sql`; if the rule doesn't currently flag the broken behavior, that's part of what we're fixing.)

For `02-in-subquery/violation.sql`:

```sql
select *
from t
where id in (select id from u)
```

For `02-in-subquery/expected.sql` (subquery body indented and on its own line):

```sql
select *
from t
where id in (
    select id
    from u
)
```

(Adjust per the rule's prescription.)

- [ ] **Step 4: Run, iterate, sanity, commit**

```bash
npx vitest run src/test/ninja/rule-parity.test.ts -t "indent-bracket"
# iterate
npx vitest run src/test/ninja/
git add src/test/ninja/fixtures/rules/ninja.layout.indent-bracket/ src/ninja/reflow/ src/ninja/rules/layout-indent-bracket.ts
git commit -m "fix(ninja): parity for layout.indent-bracket (IN-list vs subquery)"
```

---

## Task 9: Repeat the loop for the remaining structural rules

**Files:**
- Create: `src/test/ninja/fixtures/rules/<rule-id>/violation.sql`, `expected.sql`, optional `config.json`
- Modify: as needed across `src/ninja/reflow/` and `src/ninja/rules/`

The remaining ~33 structural rules each get the same five-step treatment:

1. Read the rule's `check()` function.
2. Write `violation.sql` and `expected.sql` by hand.
3. Run the parity harness, observe which of the four assertions fails.
4. Iterate fixes in the formatter, rule, or fixture until green.
5. Run the full ninja suite as sanity, commit.

Suggested order (from the spec's cutting order; pick whichever cluster you want to drive next):

1. `ninja.layout.select-targets`, `ninja.layout.long-lines` — SELECT-list wrap.
2. `ninja.convention.comma-position` (needs `config.json` for the leading variant), `ninja.convention.operator-position` (same).
3. `ninja.convention.union-style`, `ninja.convention.trailing-comma`.
4. `ninja.jinja.padding`, `ninja.jinja.argument-spacing`.
5. `ninja.layout.binary-operator-spacing`, `ninja.layout.comma-spacing`, `ninja.layout.function-spacing`, `ninja.layout.spacing`.
6. `ninja.layout.clause-keyword`, `ninja.layout.set-operator`.
7. Every `ninja.layout.indent-*` not yet covered: `indent`, `indent-body`, `indent-comments`, `indent-from`, `indent-group-by`, `indent-having`, `indent-joins`, `indent-limit`, `indent-on`, `indent-order-by`, `indent-set-op`, `indent-then`, `indent-where`.
8. `ninja.layout.leading-whitespace`, `ninja.layout.max-blank-lines`, `ninja.layout.trailing-whitespace`, `ninja.layout.select-modifiers`.

Each completed rule = one commit. Use `fix(ninja): parity for <rule-id>` as the commit message format.

**When to use a `config.json`:**

Rules whose canonical form is config-dependent (`commaPosition`, `operatorPosition`, `unionStyle`, capitalisation policies). Example for the leading-comma variant:

```json
{ "layout": { "commaPosition": "leading" } }
```

Drop it in the fixture directory beside the SQL files.

**When to use a shape-variant subdirectory:**

When one rule has two genuinely different canonical forms (like indent-bracket's IN-list vs IN-subquery), use variant subdirectories. Don't use them just to cover more examples — quality over quantity.

**Watch for assertion 4 (cross-rule) failures:**

These mean two rules' canonical forms disagree. Refine the rule definitions until they don't. Do not weaken assertion 4.

**Watch the corpus test:**

The corpus test is `.skip` until Task 10. To check progress on real models mid-rollout, temporarily remove `.skip` from `describe('corpus parity', ...)` and run:

```bash
npx vitest run src/test/ninja/corpus-parity.test.ts
```

The remaining failures are your work list. Re-apply `.skip` before committing — it stays skipped until Task 10 flips it for good.

---

## Task 10: Enable rule-completeness check

**Files:**
- Modify: `src/test/ninja/rule-parity.test.ts`

Once every structural rule has at least one fixture, flip the completeness check from `describe.skip` to `describe`.

- [ ] **Step 1: Confirm coverage**

```bash
npx vitest run src/test/ninja/rule-parity.test.ts
```

Expected: all parameterised fixtures pass; "structural rule completeness" still skipped.

- [ ] **Step 2: Flip both skips**

Edit `src/test/ninja/rule-parity.test.ts`. Change:

```typescript
describe.skip('structural rule completeness', () => {
```

to:

```typescript
describe('structural rule completeness', () => {
```

Edit `src/test/ninja/corpus-parity.test.ts`. Change:

```typescript
describe.skip('corpus parity', () => {
```

to:

```typescript
describe('corpus parity', () => {
```

- [ ] **Step 3: Run to confirm green**

```bash
npx vitest run src/test/ninja/rule-parity.test.ts src/test/ninja/corpus-parity.test.ts
```

Expected: every structural rule passes its completeness check; every `samples/*/models/**/*.sql` produces lint-clean formatter output.

If anything is still red, add the missing fixtures — the failure message names the rule.

- [ ] **Step 4: Final sanity — full test suite**

```bash
npm test
```

Expected: every test passes.

- [ ] **Step 5: Commit**

```bash
git add src/test/ninja/rule-parity.test.ts src/test/ninja/corpus-parity.test.ts
git commit -m "test(ninja): enable parity completeness gate and corpus check"
```

---

## Done

When Task 10 ships:
- Every structural rule has at least one fixture under `src/test/ninja/fixtures/rules/`.
- All four parity assertions pass for every fixture.
- The real-world corpus parity test passes on every dbt model under `samples/`.
- The structural-rule completeness gate enforces that no new structural rule can land without a fixture.
- The formatter and the structural linter rules have a single, machine-verified definition of canonical form.
