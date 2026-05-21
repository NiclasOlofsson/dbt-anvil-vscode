# Formatter / Linter Parity for Structural Rules

## Problem

The formatter and the structural linter rules are supposed to share one contract:
**anything a structural rule flags, "Format Document" fixes; anything the formatter
produces, no structural rule flags.** Today they don't. Running the formatter on
real dbt models produces output the linter would still complain about — CTE
separators that don't break, SELECT lists that don't wrap, IN-lists indented as
if they were subqueries, Jinja control flow collapsing inline.

The contract is already encoded in [src/ninja/engine.ts:309-368](../../../src/ninja/engine.ts#L309-L368)
as the `FIX_SCOPE_TABLE`, which classifies ~36 rules as `'structural'` —
diagnostics only, formatter owns the fix. The bug is that the formatter doesn't
honour the classification.

## Goal

Make the contract enforceable in CI through a single test harness driven by
hand-crafted fixtures. Each structural rule gets one fixture pair that doubles
as the linter spec and the formatter spec — they cannot diverge because they
are tested from the same input.

## Harness

### Layout

```
src/test/ninja/fixtures/rules/
  <rule-id>/
    violation.sql      # broken input — triggers exactly this rule
    expected.sql       # what the formatter must produce, lint-clean
    config.json        # optional; non-default config that defines the canonical form
```

`<rule-id>` is the literal rule id, e.g. `ninja.layout.cte-bracket/`.

### Test flow

For each fixture directory:

```
   violation.sql                       expected.sql
        |                                    |
        | lint                               | lint
        v                                    v
  (rule fires)                           (clean)

        | format
        v
     output ────── must byte-equal expected.sql
        |
        | lint
        v
     (clean for every rule)
```

Four assertions:

1. **Rule detects:** `lint(violation.sql)` reports the target rule ≥ 1 time.
2. **Formatter produces the canonical form:** `format(violation.sql)` byte-equals `expected.sql`.
3. **Expected is canonical:** `lint(expected.sql)` reports zero violations of the target rule.
4. **Full lint clean:** `lint(format(violation.sql))` is empty for every structural rule.

Assertion 4 is the cross-rule guard. It is what stops a fix to rule A from
introducing a violation of rule B, and what forces the rule set to stay
globally consistent as fixtures land.

### Per-fixture config

When a rule's canonical form depends on non-default config — `convention.comma-position`,
`convention.operator-position`, `convention.union-style`, capitalisation
policies — drop a `config.json` next to the SQL files:

```json
{ "layout": { "commaPosition": "leading" } }
```

The harness deep-merges it over `DEFAULT_CONFIG`. Both lint and format use the
same merged config. Absent file → sqlfmt preset baseline.

One fixture pair per rule by default. Rules with a meaningful alternate config
branch (e.g. comma-position) can have a sibling directory
`<rule-id>--<variant>/` with its own pair and `config.json`. No header-comment
parsing.

### Fixture authoring discipline

- **Minimal.** Smallest SQL that triggers the target rule. Avoid incidental
  violations of other rules where practical; `expected.sql` MUST be globally
  clean (assertion 4 enforces this), but `violation.sql` is allowed to
  trigger ancillary rules — assertion 1 only checks that the target rule is
  among the violations.
- **Hand-crafted.** `expected.sql` is committed by hand as the authoritative
  spec of the canonical form. Never auto-generated from current formatter
  output — that would freeze in today's bugs as tomorrow's spec.
- **One per rule by default; more when shape demands it.** Quality not
  quantity. See the coverage section below.

## Coverage

Four mechanisms, layered. Each addresses a gap the others can't see.

### 1. Rule-completeness (auto-enforced)

The harness reads the structural rule list from `FIX_SCOPE_TABLE`
([src/ninja/engine.ts:309-368](../../../src/ninja/engine.ts#L309-L368)) and
asserts a fixture directory exists for every entry. Missing a rule → test
fails with the exact rule id. New structural rule → must ship with a fixture
in the same PR; the test enforces it, not code review.

### 2. Per-rule shape coverage (multi-fixture)

One fixture per rule is the minimum, not the cap. A rule like
`layout.cte-bracket` has several shapes — close-paren-on-own-line,
open-paren-position, comma-between-CTEs, terminal-CTE. The harness supports
multiple fixture pairs per rule via numbered subdirectories:

```
ninja.layout.cte-bracket/
  01-close-paren/violation.sql, expected.sql
  02-open-paren/violation.sql, expected.sql
  03-cte-separator/violation.sql, expected.sql
```

Each subdirectory is run independently with the same four assertions. Authors
add a subdirectory when a single fixture can't capture the rule's surface —
driven by what's actually broken, not theoretical exhaustiveness.

When a rule has both a single canonical fixture AND subdirectories, the
single-fixture form is the bare-rule directory; subdirectories live alongside.

### 3. Real-world corpus parity

A separate test loads every `*.sql` under
`samples/jaffle_shop/models/` and `samples/nba-monte-carlo/models/`, runs
the formatter, and asserts `lint(format(file))` returns zero structural
violations. No golden file — too brittle on real models. Just the contract.

This is the rubber-meets-road check. If a CTE-separator fixture and a
SELECT-wrap fixture both pass in isolation but their interaction breaks on a
real two-CTE-with-long-SELECT-list file, this test fails when the per-rule
fixtures didn't. A failure here is the signal to add a new fixture (per-rule
or shape-specific) that exercises the interaction; do not "fix" by tweaking
the model.

### 4. Coverage report on the printer

Run `vitest --coverage` against [src/ninja/reflow/printer.ts](../../../src/ninja/reflow/printer.ts)
and the layout/spacing engines. Surfaces untouched branches — e.g.
`parenOpensIndent` paths for `EXISTS`, `NOT_IN` that might have no fixture
exercising them. Not a CI gate, just an audit signal: "where are our blind
spots." Run before each release or whenever the printer touches new logic.

### What we skip

- **Mutation testing.** Overkill. Assertion 1 (rule fires on `violation.sql`)
  plus assertion 3 (rule clean on `expected.sql`) already proves the rule
  discriminates between the two states.
- **Golden files on real samples.** Brittle. Models change, contributors edit
  them, churn drowns signal. The corpus test (mechanism 3) asserts the
  contract instead of the exact bytes.
- **Generated fixtures.** Fixtures are the spec; the spec must be
  human-readable.

## Implementation loop (TDD)

For each structural rule, in any order:

1. Write `violation.sql` and `expected.sql` by hand.
2. Run the harness. Failure mode tells you what's broken:
   - Assertion 1 fails → rule detector is wrong.
   - Assertion 2 fails → formatter doesn't produce canonical form.
   - Assertion 3 fails → expected file isn't actually canonical.
   - Assertion 4 fails → another structural rule disagrees with this rule's canonical form.
3. Fix the rule, the formatter, or both until all four pass.
4. Next rule.

Rules where the formatter and linter already agree pass on first commit of
their fixture — no code change. The ones that fail are the work list. No
phases, no gating — each fixture commit is an independent unit.

### Suggested cutting order

Driven by where the real-world breakage lives:

1. `ninja.layout.cte-bracket`, `ninja.layout.cte-blank-line` — CTE separators (worst observed bug).
2. `ninja.layout.indent-bracket` — IN-list vs subquery distinction.
3. `ninja.layout.select-targets`, `ninja.layout.long-lines` — SELECT-list wrap.
4. `ninja.convention.comma-position`, `ninja.convention.operator-position` — proves the `config.json` mechanism end-to-end.
5. The remaining ~30 structural rules.

## Scope

**In:** All ~36 rules classified `'structural'` in
[src/ninja/engine.ts:309-368](../../../src/ninja/engine.ts#L309-L368).

**Out:**

- Surgical rules (~17) — they have their own per-violation code-action contract.
  The harness pattern could be reused later as a separate spec.
- Detection-only rules (~32) — they don't promise a fix.
- Comment-attachment fidelity bugs (parser/printer issues, not style rules) —
  these surfaced in the real-sample probe but belong in a separate bug fix,
  not this spec.

## Risks

- **Fixture cross-conflict.** Assertion 4 forces every `expected.sql` to be
  globally clean. As fixtures land, two rules' canonical forms may turn out
  to disagree. Resolution: refine the rules until they don't. Do not weaken
  assertion 4.
- **Test boot cost.** Pyodide takes ~5s to boot. The existing format-roundtrip
  test already pays this in `beforeAll`. The new harness reuses the same boot;
  no new dependency.

## Done criteria

- One fixture pair per structural rule committed under `src/test/ninja/fixtures/rules/`,
  enforced by the rule-completeness check (coverage mechanism 1).
- All four assertions pass for every fixture (including any shape
  subdirectories).
- The real-world corpus parity test (coverage mechanism 3) passes on every
  `*.sql` under `samples/*/models/`.
