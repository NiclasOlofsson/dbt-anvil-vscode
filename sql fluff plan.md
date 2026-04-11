# Plan: Ninja — Replace SQLFluff

## TL;DR

Replace SQLFluff entirely with **Ninja** — a built-in linter and formatter that leverages the existing sqlglot parser and jinja tokenizer. Everything is parser-based (no regex scanning). The extension already parses every document for providers, so Ninja piggybacks on `ParseService.getDocumentModel()` — rules consume the existing `DocumentModel` (tokens, CTEs, aliases, scope). Pure layout checks (whitespace, indentation) use simple string ops, not regex. Namespace is `ninja` everywhere: code (`src/ninja/`), diagnostic source, settings (`dbt-studio.ninja.*`), rule IDs (`ninja.cap.keywords`). Supports `.sqlfluff` config for migration.

## Architecture

**Single execution model**: all rules run after `ParseService.getDocumentModel()` returns. The document is already parsed for hover/completion/diagnostics — Ninja adds zero extra parse cost.

**Two rule types** (same lifecycle, different inputs):

1. **Token rules** — consume the token stream from the bridge response (`DocumentModel.tokens`: `column_ref`, `table_ref`, `column_def`, plus new token types for keywords/functions/literals). Capitalization, aliasing, reference rules. **Requires bridge extension**: `parse_document` must emit keyword/function/literal tokens alongside existing column/table tokens.

2. **Layout rules** — consume raw document text with simple string ops (`charAt`, `indexOf`, line iteration). Whitespace, indentation, line length, trailing newlines. No regex. The jinja token positions from `JinjaTokenizer` mark regions to skip.

AST-level structural rules (unused CTE, case patterns, join analysis) are **bridge-side**: extend `parse_document` to detect patterns in the sqlglot AST and emit violations in the response.

---

## Phase 1: Foundation — Ninja Engine & Configuration

### Step 1.1: Ninja Core (`src/ninja/`)
- `src/ninja/rule.ts` — `NinjaRule` interface: `{ id: string, category: NinjaCategory, severity, fixable, check(ctx): NinjaViolation[] }`. Sub-interfaces: `TokenRule` (receives `DocumentModel`), `LayoutRule` (receives raw text + jinja token positions).
- `src/ninja/violation.ts` — `NinjaViolation`: `{ rule: string, message: string, range: Range, fix?: TextEdit[] }`.
- `src/ninja/engine.ts` — `NinjaEngine`: receives parse result + raw text, runs all enabled rules, returns violations. No scheduling — called by diagnostics provider after parse completes.
- `src/ninja/categories.ts` — `NinjaCategory` enum.

### Step 1.2: Configuration (`src/ninja/config.ts`, `src/ninja/config-loader.ts`)
- `NinjaConfig` type with all options.
- Resolution: VS Code settings (`dbt-studio.ninja.*`) → `.sqlfluff` file (INI parse, map SQLFluff codes) → inline `-- noqa` / `-- noqa: ninja.cap.keywords` suppression (SQLFluff `-- noqa: CP01` also supported).
- Config loader walks up from file to workspace root for `.sqlfluff`.

### Step 1.3: Bridge Extension
Extend `parse_document` response to include:
- **`keywords`**: `{ text: string, line: number, col: number, endCol: number }[]` — every SQL keyword with exact original text (for casing checks)
- **`functions`**: same shape — function name tokens
- **`literals`**: same — NULL/TRUE/FALSE and datatype keywords
- **`lintViolations`**: `{ rule: string, message: string, line, col, endCol, fix?: string }[]` — AST-level structural violations detected in Python (unused CTE, case patterns, join analysis, etc.)

This is an additive change to the existing response. Flag `lint: true` in the request to opt in.

### Step 1.4: Diagnostics Integration
- New collection `ninja` in `DbtDiagnosticsProvider` (source: `'ninja'`)
- After `ParseService.getDocumentModel()` → run `NinjaEngine.check()` → set diagnostics
- Each violation: `code` = rule ID (e.g. `ninja.cap.keywords`), `source` = `'ninja'`

### Step 1.5: VS Code Settings
`dbt-studio.ninja.*` in `package.json`:
- `enabled` (boolean, default true)
- `rules` (object — per-rule severity/enable)
- `indentation.unit` (`space` | `tab`)
- `indentation.size` (number, default 4)
- `maxLineLength` (number, default 120)
- `capitalisation.keywords` (`upper` | `lower` | `consistent`)
- `capitalisation.functions` (`upper` | `lower` | `consistent`)
- `capitalisation.literals` (`upper` | `lower` | `consistent`)
- `layout.commaPosition` (`trailing` | `leading`)
- `layout.operatorPosition` (`trailing` | `leading`)

---

## Phase 2: Token Rules (from bridge token stream)

Consume `DocumentModel.tokens` + the new `keywords`/`functions`/`literals` arrays.

### Step 2.1: Capitalization Rules
| Rule ID | SQLFluff | Fixable | Source |
|---------|----------|---------|--------|
| `ninja.cap.keywords` | CP01 | ✓ | `keywords` array — check `.text` against policy |
| `ninja.cap.functions` | CP03 | ✓ | `functions` array |
| `ninja.cap.literals` | CP04 | ✓ | `literals` array (NULL/TRUE/FALSE) |
| `ninja.cap.types` | CP05 | ✓ | `literals` array (datatype keywords) |

### Step 2.2: Aliasing Rules (from existing tokens + new fields)
| Rule ID | SQLFluff | Fixable | Source |
|---------|----------|---------|--------|
| `ninja.alias.implicit-table` | AL01 | ✓ | Bridge: table alias without AS |
| `ninja.alias.implicit-column` | AL02 | ✓ | Bridge: column alias without AS |
| `ninja.alias.expression-no-alias` | AL03 | — | Bridge: complex expr without alias |
| `ninja.alias.unique-table` | AL04 | — | `table_ref` tokens — check for duplicates |
| `ninja.alias.unused` | AL05 | ✓ | `aliases` map vs `column_ref` token usage |
| `ninja.alias.self-alias` | AL09 | ✓ | Bridge: `col AS col` |

### Step 2.3: Reference Rules
| Rule ID | SQLFluff | Fixable | Source |
|---------|----------|---------|--------|
| `ninja.ref.qualify-columns` | RF02 | — | Multi-source query + unqualified `column_ref` in tokens |
| `ninja.ref.keywords-as-identifiers` | RF04 | — | Bridge: identifier matches keyword |

### Step 2.4: Jinja Rules
| Rule ID | SQLFluff | Fixable | Source |
|---------|----------|---------|--------|
| `ninja.jinja.padding` | JJ01 | ✓ | `JinjaTokenizer.tokenize()` — check first/last char inside delimiters |

---

## Phase 3: Layout Rules (simple string ops, no regex)

Consume raw document text. Use `JinjaTokenizer` positions to mark jinja regions (skip them for SQL layout checks).

| Rule ID | SQLFluff | Fixable | Implementation |
|---------|----------|---------|----------------|
| `ninja.layout.trailing-whitespace` | LT01 | ✓ | Iterate lines, check `line[line.length-1]` for space/tab |
| `ninja.layout.indent` | LT02 | ✓ | Count leading spaces/tabs per line vs config, skip jinja regions |
| `ninja.layout.long-lines` | LT05 | — | `line.length > maxLineLength`, skip jinja-heavy lines |
| `ninja.layout.function-spacing` | LT06 | ✓ | From `functions` token: check char before `(` is not space |
| `ninja.layout.trailing-newline` | LT12 | ✓ | Check last char of file |
| `ninja.layout.leading-whitespace` | LT13 | ✓ | Check first line |
| `ninja.layout.max-blank-lines` | LT15 | ✓ | Iterate lines, count consecutive empty |

Note: `ninja.layout.function-spacing` actually uses the `functions` token stream (position of function name → check next chars in raw text). Parser-informed, not regex.

---

## Phase 4: AST Rules (bridge-side, in `lintViolations`)

Detected by sqlglot in `parse_document` when `lint: true`. Emitted as `lintViolations` in the response. TypeScript just maps them to diagnostics.

### Step 4.1: Structure
| Rule ID | SQLFluff | Fixable | Detection |
|---------|----------|---------|-----------|
| `ninja.struct.unused-cte` | ST03 | — | CTE defined, never referenced in scope |
| `ninja.struct.else-null` | ST01 | ✓ | CASE with `ELSE NULL` |
| `ninja.struct.simple-case` | ST02 | ✓ | `CASE WHEN x THEN TRUE ELSE FALSE` |
| `ninja.struct.distinct-parens` | ST08 | ✓ | `DISTINCT(col)` → `DISTINCT col` |
| `ninja.struct.subquery-in-join` | ST05 | — | Subquery in FROM/JOIN position |
| `ninja.struct.unused-join` | ST11 | — | Joined table, no columns referenced |
| `ninja.struct.nested-case` | ST04 | — | CASE inside ELSE of CASE |

### Step 4.2: Ambiguity
| Rule ID | SQLFluff | Fixable | Detection |
|---------|----------|---------|-----------|
| `ninja.ambig.distinct-groupby` | AM01 | ✓ | DISTINCT + GROUP BY |
| `ninja.ambig.bare-union` | AM02 | ✓ | UNION without ALL/DISTINCT |
| `ninja.ambig.implicit-join` | AM05 | ✓ | JOIN without qualifier |

### Step 4.3: Convention
| Rule ID | SQLFluff | Fixable | Detection |
|---------|----------|---------|-----------|
| `ninja.conv.not-equal` | CV01 | ✓ | Inconsistent != vs <> |
| `ninja.conv.coalesce` | CV02 | ✓ | IFNULL/NVL → COALESCE |
| `ninja.conv.is-null` | CV05 | ✓ | `= NULL` → `IS NULL` |
| `ninja.conv.left-join` | CV08 | ✓ | RIGHT JOIN → LEFT JOIN |
| `ninja.conv.count-rows` | CV04 | ✓ | COUNT(1) → COUNT(*) |

---

## Phase 5: Code Actions — Four Tiers

### Tier 1: Auto-fix (`QuickFix`)
All currently fixable rules. One-click or format-on-save. Every fixable violation emits `NinjaViolation.fix: TextEdit[]`.

### Tier 2: Suggested fix (`QuickFix` with smart default)
Rules previously marked non-fixable but deterministic given parse info:
| Rule | Suggested fix |
|------|---------------|
| `ninja.alias.expression-no-alias` (AL03) | "Add alias 'order_count'" — derive from expression (count(orders) → order_count) |
| `ninja.ref.qualify-columns` (RF02) | "Qualify as 'orders.id'" — scope resolution knows the source table |
| `ninja.ref.keywords-as-identifiers` (RF04) | "Rename to 'order_date'" — suggest prefixed alternative |
| `ninja.alias.unique-table` (AL04) | "Rename alias to 'o2'" — increment duplicate |
| `ninja.struct.unused-cte` (ST03) | "Remove CTE 'unused_cte'" — delete the CTE block |

### Tier 3: Refactoring (`Refactor` / `RefactorExtract` / `RefactorInline`)
Structural rewrites, available **always** (not just on diagnostics), in Refactor menu + lightbulb:
| Action | Trigger | Kind |
|--------|---------|------|
| Extract subquery to CTE | Cursor on subquery in FROM/JOIN | `RefactorExtract` |
| Flatten nested CASE | Cursor on nested CASE expression | `Refactor` |
| Break long line at clause boundary | Cursor on long line | `Refactor` |
| Remove unused JOIN | Cursor on unreferenced join | `Refactor` |
| Inline CTE | Cursor on CTE name (single use) | `RefactorInline` |
| Extract CTE to model | Cursor on CTE name | `RefactorExtract` |

### Tier 4: Explain via Copilot
For ambiguous violations, offer "Explain with Copilot" code action that opens Copilot Chat with context (the violation, the rule, the surrounding SQL). Uses chat participant API or `vscode.commands.executeCommand('vscode.editorChat.start', { message })`.

---

## Phase 6: Formatter

### Step 6.1: Formatting Provider (`src/providers/sql/formatting-provider.ts`)
Replace stub with `DocumentFormattingEditProvider` + `DocumentRangeFormattingEditProvider`:
- Calls `NinjaEngine.check()` → collects all Tier 1 + Tier 2 fix edits → returns `TextEdit[]`
- Register for `jinja-sql` language in `extension.ts`
- Standard `editor.formatOnSave` integration

### Step 6.2: Commands
- `dbt-studio.formatDocument` command
- `source.fixAll.ninja` code action kind for VS Code "Fix All"

### Step 6.3: Advanced Formatting (stretch)
- Clause-per-line, CTE formatting, comma reflow, operator alignment
- These require AST → text reconstruction, harder than individual fixes
- Could add a bridge `format_document` handler that uses sqlglot's `sql()` generation with formatting options

---

## Phase 7: SQLFluff Migration

- Detect `.sqlfluff` → notification: "Ninja can replace SQLFluff. [Migrate] [Dismiss]"
- Migrate: read `.sqlfluff`, map to `dbt-studio.ninja.*` settings
- Update `_updateSqlFluffDiagnostic()` to suggest disabling/uninstalling SQLFluff

---

## Relevant Files

### New files
- `src/ninja/rule.ts` — Rule interfaces
- `src/ninja/violation.ts` — Violation type
- `src/ninja/engine.ts` — Rule runner
- `src/ninja/config.ts` — NinjaConfig type
- `src/ninja/config-loader.ts` — .sqlfluff parser + settings merge
- `src/ninja/categories.ts` — Category enum
- `src/ninja/rules/cap/` — Capitalization rules
- `src/ninja/rules/alias/` — Aliasing rules
- `src/ninja/rules/ref/` — Reference rules
- `src/ninja/rules/jinja/` — Jinja rules
- `src/ninja/rules/layout/` — Layout rules
- `src/ninja/rules/struct/` — Structure rules (thin wrappers, violations come from bridge)
- `src/ninja/rules/ambig/` — Ambiguity rules
- `src/ninja/rules/conv/` — Convention rules

### Existing files to modify
- `src/providers/sql/formatting-provider.ts` — Replace stub with real formatter
- `src/providers/diagnostics-provider.ts` — Add ninja diagnostic collection, wire engine
- `src/providers/sql/code-action-provider.ts` — Quick-fix code actions
- `src/extension.ts` — Register formatter, ninja engine
- `package.json` — `dbt-studio.ninja.*` settings
- `resources/bridge/bridge.py` — Extend `parse_document`: emit `keywords`/`functions`/`literals` tokens + `lintViolations`

### Reference (patterns to reuse)
- `src/providers/diagnostics-provider.ts` — Diagnostic collection lifecycle pattern
- `src/dbt/jinja-tokenizer.ts` — `tokenize()` for jinja-aware position mapping
- `src/services/parse-service.ts` — `DocumentModel`, `getDocumentModel()` for token access
- `src/dbt/statement-splitter.ts` — Statement boundary detection

---

## Verification

1. **Unit tests per rule** — SQL snippets with/without jinja
2. **Config loader tests** — .sqlfluff parsing + mapping
3. **Formatter tests** — before/after pairs
4. **Integration** — jaffle_shop models: diagnostics appear, format clears them
5. `npm test` after each phase
6. **Performance** — profile with 500+ line models, verify no added latency vs current parse

---

## Decisions

- **No regex** — All SQL analysis from parser tokens. Layout checks use simple string ops (charAt, indexOf, line iteration). Jinja positions from tokenizer mark skip regions.
- **Namespace `ninja`** everywhere — code, settings, diagnostic source, rule IDs
- **Bridge extension over separate handler** — add `lint: true` flag + new token arrays to `parse_document` response
- **Scope** — ~40 rules covering SQLFluff's most useful checks. Omit dialect-specific (OR01, TQ01-03) and highly opinionated (AL07, ST07).
- **.sqlfluff compat** — read config for migration, support `-- noqa` syntax

---

## Further Considerations

1. **Token emission cost**: Adding keyword/function/literal tokens to `parse_document` increases response size. Profile to ensure bridge→TypeScript pipe isn't a bottleneck. May want to emit only when `lint: true`.

2. **Ship order**: Phase 1+2+3+5+6 first (foundation + token rules + layout rules + code actions + formatter). AST rules (Phase 4) and migration (Phase 7) follow. This gives immediate value without bridge changes.

3. **Advanced formatting (Phase 5.3)**: Full SQL reformatting (clause-per-line, reflow) is substantially harder than fix-based formatting. Consider as separate feature after core Ninja ships.
