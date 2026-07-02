# Extractor → DocumentModel inventory

Census for the sqlglot→sqllens migration (`C:\Users\nicke\.claude\plans\using-this-alias-humming-beacon.md`,
Phase 1). Per the "hybrid-clean" decision, `src/ftl/extractors/*` are **replaced**, not adapted: this
document is the map from what each extractor produces today to what sqllens's `analyze()` output
(`ast` IR + `scopes` + `qualification` + `symbols` + `lineage`, see `src/ftl/sqllens/api.ts`) already
carries, so the replacement code can be written against the right sqllens field instead of re-deriving it.

Position-convention note up front, load-bearing for every row below:

- **sqlglot side (today):** `AstPayload.m.line` is **1-based**; `m.col` is **0-based, exclusive end**
  (`src/ftl/parse-result.ts:9`, `src/ftl/ast-utils.ts:99-106` — start col is computed as `m.col - name.length`).
  `SqlToken.line` is **0-based** but `SqlToken.col` is documented as sqlglot's "1-based end column
  (= 0-based exclusive end col)" (`src/ftl/parse-result.ts:52-53`) — line and col are on different bases
  on the same struct. `DocumentModel`'s own fields (`CteInfo`, `ColumnRefToken`, etc.) are uniformly
  **0-based line, 0-based inclusive start col, 0-based exclusive end col** (`src/services/parse-service.ts`,
  every field comment).
- **sqllens side:** ANTLR-native throughout — `line` **1-based**, `column`/`endColumn` **0-based**,
  `endColumn` one past the last char (`src/token/token.ts:33-36`, `src/symbols/symbols.ts:45-50`,
  `src/qualify/qualify.ts:29-36`, `src/parse-diagnostics.ts:20-27` in sql-dialect-grammars). Converting
  to the extension's convention is `line - 1`; `column`/`endColumn` need no arithmetic (sqllens always
  gives both start and end directly — no `endCol - name.length` reconstruction needed anywhere).

---

## 1. `cte-extractor.ts` — `extractCtes`, `extractSubqueries`

**DocumentModel fields:** `ctes: CteInfo[]` (both WITH-clause CTEs and subquery aliases, concatenated in
`ftl-document-parser.ts:135`).

| CteInfo field | sqlglot today | sqllens source | Verdict |
|---|---|---|---|
| `.name` | `CTE.alias→TableAlias→this(Identifier)` leaf value (`cte-extractor.ts:18-24`) | `CteDef.name` (`ir.ts:443`) | DELETE |
| `.line`/`.col` | `identifierPosition` on the name Identifier's own `_meta` (`cte-extractor.ts:26-27`) | **Not a separate IR field.** `CteDef.cst` is the whole `name AS (...)` clause (`databricks/lower.ts:551-578`, `lowerNamedQuery` sets `cst: namedQuery`), not just the name token. Getting the name-token span means walking the CST escape hatch (`CteDef.cst` is a real `ParserRuleContext`; the per-dialect generated context class exposes an `errorCapturingIdentifier()`-style accessor whose own token span can be read) | REWRITE-SUBSTANTIAL (per-dialect CST walk, not an IR field) |
| `.endLine`/`.endCol` (closing paren) | Byte-scan: find `(` after the name's line via `sql.indexOf`, then `findMatchingParen` skips strings/comments (`cte-extractor.ts:30-41`, `sql-paren-utils.ts:58-114`) | `CteDef.cst.stop` — the named-query rule's last consumed token, which for `name AS ( query )` is the closing `)` itself. No byte-scanning needed. | DELETE |
| `.columns` (name+line+col per output column) | `expressionsOf(bodySelect)` + `getColumnExprMetadata` per expr (alias-identifier position, or first identifier; `*` on qualified-star Column) (`cte-extractor.ts:52-60`) | `CteDef.body.body` (when a `SelectExpr`) → `projections: Projection[]`, each with `.name?`, `.isStar`, `.expr`, `.cst` directly | REWRITE-SMALL |
| `.columns` position when column is aliased vs bare | alias-Identifier `_meta` preferred, else first-descendant Identifier `_meta` (`column-expr-helpers.ts:31-49`) | `Projection` has one `cst` for the whole projection (start/expr through alias) — **no separate alias-identifier span**, same category gap as the per-part column-ref span issue below (not on the plan's named-blocked list, but structurally identical: an IR node with one span covering more than the sub-token the extension wants) | Open question (see below) |
| wildcard CTE columns (`SELECT *` inside a CTE, restored via `wildcardCtes` side-channel because sqlglot's `qualify()` destructively expands it) | `result.wildcardCtes` cross-referenced by CTE name (`cte-extractor.ts:45-51`) | Not needed. sqllens's `qualify()` never mutates the IR (`Projection.isStar`/`expr.kind==='star'` survive untouched); the CTE's `*` column is read straight off `Projection` like any other | DELETE (side-channel disappears entirely) |
| UNION-bodied CTE unwrap (`unwrapToSelect`, walking `this` chain through `With`/`Union` wrappers) | `unwrapToSelect(ast, ...)` (`ast-utils.ts:145-151`) | `CteDef.body.body` is typed `QueryBody = SelectExpr \| SetOpExpr \| PipeExpr` — a `SetOpExpr` carries `.left`/`.right` directly (`ir.ts:207-221`); no generic tree-walk needed, just a `switch` on `.kind` | DELETE |
| `extractSubqueries` (Subquery node → CteInfo with `isSubquery: true`) | `Subquery` AST node with `alias→TableAlias→this(Identifier)` (`cte-extractor.ts:74-101`) | `SubquerySource` (`ir.ts:431-440`): `.alias`, `.aliasCst` (a real per-alias CST span — cleaner than sqlglot here), `.query` | REWRITE-SMALL |

**Net verdict: REWRITE-SUBSTANTIAL.** The column-list and end-paren logic collapse to direct field reads
(genuine simplification); the CTE-name-token span requires a new per-dialect CST accessor that doesn't
exist as a flat IR field today.

---

## 2. `tokens-extractor.ts` — `extractTokens`, `resolveTableRefs`

**DocumentModel fields:** `tokens: TokenInfo[]` (`ColumnRefToken | TableRefToken | ColumnDefToken`).

| Token kind / field | sqlglot today | sqllens source | Verdict |
|---|---|---|---|
| `column_ref` (from `Column` nodes) `.name`/`.line`/`.col`/`.endCol` | `Column.this(Identifier)` own `_meta` (`tokens-extractor.ts:37-44`) | `ColumnRef` (`ir.ts:110-116`): `.parts: string[]`, one `.cst` for the whole dotted reference | REWRITE-SMALL (name = last part; span = whole-ref cst, not just the column-name sub-token) |
| `column_ref` `.table`/`.tableLine`/`.tableCol`/`.tableEndCol` (qualifier span, e.g. `o` in `o.order_id`) | Separate `Column.table(Identifier)` with its own `_meta`, distinct from the column-name Identifier (`tokens-extractor.ts:48-60`) | **BLOCKED.** `ColumnRef.parts` is a flat `string[]` with a single `cst` for the whole reference — no per-part span. This is the plan's named gap ("per-part column-ref spans", `using-this-alias-humming-beacon.md` Phase 0 item 2 / assessment table row 1) — the extension resolves cursor-on-qualifier distinctly from cursor-on-column and needs it | BLOCKED on sqllens per-part spans |
| `column_ref.scopeId` (nearest enclosing `Subquery`/`CTE`, via parent-chain walk `innermostScope`) | `ast-utils.ts:84-91` | `Sym.frame` (a name, not an index) already carries this per-symbol (`symbols/symbols.ts:57-59`); no parent-chain walk needed | DELETE |
| `column_ref.resolvedTableRef` (alias→table_ref cross-reference, done by `resolveTableRefs` matching alias name + scope + "latest definition at or before the column line") | `tokens-extractor.ts:148-180` | `resolveColumn(scope, ref)` (`scope/scope.ts:143-173`) already does qualifier-based binding structurally (walking `Scope.parent` for correlation) — `ColumnResolution.bound.source` is the resolved `ResolvedSource`; `Sym.definition` (`symbols.ts:60-63`) is the in-query declaration span it resolves to | DELETE (native scope resolution replaces the hand-rolled alias-matching heuristic) |
| `column_def` (from `Alias` nodes) | `Alias.alias(Identifier)` (`tokens-extractor.ts:66-75`) | Same alias-identifier-span gap as CTE columns above — `Projection` has no distinct alias-token `cst` | Open question (see below) |
| `table_ref` (from `Table` nodes) `.name`/`.line`/`.col`/`.endCol` | `Table.this(Identifier)` own `_meta` (`tokens-extractor.ts:78-84`) | `TableSource.name: string[]` + one `.cst` (`ir.ts:414-429`) — per-part span not confirmed distinct for multi-part names (unverified against a specific dialect's `lower.ts`, flagged below) | REWRITE-SMALL |
| `table_ref.alias`/`.aliasLine`/`.aliasCol`/`.aliasEndCol` | `Table.alias(TableAlias)→this(Identifier)` own `_meta`, absent when qualify()-synthesized (`tokens-extractor.ts:89-106`) | `TableSource.aliasCst` — a dedicated per-alias CST span (`ir.ts:419`) | DELETE |
| `table_ref.synthesized` flag | Set when the alias Identifier has no `_meta` (i.e. `qualify()` invented it) (`tokens-extractor.ts:101-104`) | Never happens — sqllens's IR is frozen; `qualify()` cannot mutate it (plan §Phase 2b: "`synthesized` alias flag disappears with sqlglot") | DELETE (concept moot) |
| `table_ref.cteDefinition` flag | Set manually per CTE (`tokens-extractor.ts:22-33`, duplicating `ctes` data into `tokens`) | `Sym.kind === 'cte'`, `modifiers: ['declaration']` (`symbols.ts:88`) | DELETE |
| `table_ref.isSubquery` flag + Subquery-alias table_ref emission | `Subquery` node walk (`tokens-extractor.ts:113-138`), duplicating `extractSubqueries` | `Sym.kind === 'subquery'` from `relationSymbol` (`symbols.ts:339-346`) | DELETE |

**Net verdict: mixed, dominant BLOCKED / REWRITE-SUBSTANTIAL.** The column-qualifier span and the
alias-identifier-in-a-projection span are the two real gaps; everything else (scope id, alias-resolution,
synthesized/cteDefinition/isSubquery flags) is a clean DELETE because sqllens's `Sym`/`Scope` model
already carries it natively instead of via flags bolted onto a flat token list.

---

## 3. `final-select-extractor.ts` — `extractFinalColumns`, `extractFinalSelect`

**DocumentModel fields:** `finalColumns: ColumnInfo[]`, `finalSelect?: FinalSelectInfo`.

| Piece | sqlglot today | sqllens source | Verdict |
|---|---|---|---|
| `finalSelectNode` (unwrap root `With`/`Union` to the leftmost `Select`) | Manual `c === 'Select'` / `'Union'` / `'With'` dispatch + `unwrapToSelect` (`final-select-extractor.ts:15-25`) | `ParseResultIR.ast.body: QueryBody` is already typed (`select`/`setop`/`pipe`); a `SetOpExpr.left` walk replaces the manual unwrap | DELETE |
| `expressionBounds` (bounding box of an expression, computed by scanning every descendant `Identifier` for min/max line/col) | `final-select-extractor.ts:28-59` | `Projection.cst` (and any `Expr.cst`) gives the exact span directly (`cst.start`/`cst.stop`) — no descendant scan needed | DELETE |
| `buildSelectColumn` — `.name`/`.expression`/`.table`/`.isComplexExpression` | Class-name dispatch on `Alias`/`Column`/`Identifier`/other (`final-select-extractor.ts:76-112`) | `Projection.name`, `Projection.expr.kind` (`'column'` → `.parts`), `Projection.isStar`. The "is this a bare echoed column vs a real alias/computed expr" distinction the extension calls `isComplexExpression` is exactly the "echo" check sqllens's own symbol emitter already does (`symbols.ts:213-218`: `last.toLowerCase() === p.name.toLowerCase()`) — reusable logic, not reinvented | REWRITE-SMALL |
| `buildCommentedLines` (hand-rolled string/comment scanner to drop AST nodes whose position lands inside a comment — a jinja-blanker artifact) | `final-select-extractor.ts:138-185` | `tokenize(sql, dialect)` (`src/ftl/sqllens/api.ts:13`) returns real `Token[]` with `role: 'comment'` and exact spans (`token.ts:10-20,39`) — filter by token role instead of re-scanning the string | REWRITE-SMALL |
| SELECT-keyword position (scan backward through source lines for a line starting with `select`) | `final-select-extractor.ts:201-214` | `SelectExpr.cst.start` — the select rule's own first token — should be exact; unverified per-dialect whether the rule's CST literally starts at the `SELECT` keyword vs. an enclosing wrapper (open question) | REWRITE-SMALL |

**Net verdict: REWRITE-SMALL.** Almost every hand-rolled scan (bounding box, comment detection, keyword
search) is replaced by a direct CST/IR field or the existing `tokenize()` API — this file shrinks the most
of any extractor.

---

## 4. `lineage-walker.ts` — `walkLineageTree` (not a `DocumentModel` field; feeds `traceLineageV2`)

Consumes the Python bridge's `_dump_lineage_node` tree shape: `{ name, expression, source,
referenceNodeName, downstream }` (`lineage-walker.ts:34-49`), and reconstructs `dependencies` (base-table
columns), `via_ctes` (hop list), and `transformations` (per-CTE expression + `sources` + union `branches`,
plus a synthetic `outer_query` step) — this is the data behind the Lineage & Impact panel's transformation
graph.

sqllens's `lineage()` / `Lineage.originsOf(column)` (`sql-dialect-grammars/src/lineage/lineage.ts`,
`api.ts:206-221`) returns only a **flat** `Origin[]` per output column (`{ table: string[], column: string
}`) — the final base-table columns, with no intermediate per-CTE transformation detail, no expression
text per hop, no union-branch structure, and no `outer_query` step. This is a real gap not on the plan's
named-blocked list (Join nodes / per-part spans) but structurally comparable: sqllens's lineage pass
answers "where does this column ultimately come from," not "show me the hop-by-hop transformation tree."

**Verdict: REWRITE-SUBSTANTIAL**, and likely needs new sqllens surface (or a hand-built walk combining
`ScopeTree` + `Lineage.originsOf` per scope to reconstruct the hop detail) — flagged as an open question,
not silently assumed away.

---

## 5. `pivot-extractor.ts` — `extractPivotVirtualColumns`

**DocumentModel field:** `pivotVirtualColumns?: Record<string, string[]>`.

sqlglot today: finds `Pivot` nodes with `unpivot === true`, walks up to the parent `Table`, and hand-picks
value/name columns out of `Pivot.expressions` / `Pivot.fields→In.this` (`pivot-extractor.ts:19-56`).

sqllens: `SelectExpr.pivot?: PivotInfo` / `.unpivot?: UnpivotInfo` are already named-field structures
(`ir.ts:85-106`: `values`, `forColumns`, `aggColumns`, `valueColumn`, `nameColumn`, `removed`) — no AST
digging required. Further, `qualify()`'s `columnsOfSource`/`resolveColumns` already folds pivot/unpivot
reshaping into the resolved output-column list for the owning scope (`qualify.ts:92-99`,
`scope.ts:509-547`, `applyPivotCols`/`applyUnpivotCols`). If `CteInfo.columns` is sourced from
`Qualification.columnsOf(cteScope)` in the rewrite, the virtual columns are already present there —
`pivotVirtualColumns` as a separate `DocumentModel` field may become entirely redundant.

**Verdict: DELETE** (data is named fields already; open question whether the field survives at all once
`CteInfo.columns` goes through `qualify()`).

---

## 6. `column-expr-helpers.ts` — shared helper (`getColumnExprMetadata`, `extractColumnExprName`, `truncateExpression`)

Not a `DocumentModel` field producer itself — shared by `cte-extractor.ts` and `final-select-extractor.ts`
to resolve "what's the name/position of this SELECT-list expression" against sqlglot's `Alias`/`Column`/
`Identifier`/`Star` class dispatch (`column-expr-helpers.ts:31-73`).

Entirely subsumed by reading `Projection.name` / `Projection.isStar` / `Projection.expr.kind` directly —
no class-name dispatch or descendant search needed. `truncateExpression` (string truncation, `MAX_EXPR_LEN`)
is parser-independent and can be kept verbatim if the lineage rewrite still wants truncated expression text.

**Verdict: DELETE** (the metadata-resolution logic; `truncateExpression` alone is a trivial keep if needed).

---

## 7. `jinja-tag-extractors.ts` — `extractRefs`, `extractSources`, `extractMacroCalls`, `mapWarnings`

**DocumentModel fields:** `refs: RefInfo[]`, `sources: SourceInfo[]`, `macroCalls?: MacroCallInfo[]`,
`sqlglotWarnings?: SqlglotWarning[]`.

`extractRefs`/`extractSources`/`extractMacroCalls` walk the TS-side `JinjaToken[]` stream (from
`src/ftl/jinja-tokenizer.ts`) — pure text/jinja-token pattern matching (`{{ ref(...) }}`, `{{ source(...) }}`,
`{{ pkg.macro(...) }}`), never touching the SQL AST at all.

**Verdict: KEEP (jinja-side, parser-independent)** — confirmed by the plan's own assessment table: "Jinja |
n/a ... | works unchanged | None ✔" (`using-this-alias-humming-beacon.md` line 31).

`mapWarnings` (in this same file, despite not being jinja-related) is a different story — it maps
`ParseWarning[]` `{type: 'scope_warning'|'syntax_error', message, line, col, endCol}` to `SqlglotWarning[]`.
sqllens equivalents:
- `syntax_error` → `SyntaxDiagnostic` (`parse-diagnostics.ts:17-28`: `message`, 1-based `line`, 0-based
  `column`, `offset`, `length`) via `ParseResultIR.diagnostics` or `Analysis.errors` — clean map.
- `scope_warning` (sqlglot: "SQL parsed OK but sqlglot cannot analyse a CTE scope, e.g. a bare identifier
  before the CTE body" — `parse-service.ts:203-206`) has **no sqllens analog**: `resolveScopes()` is total
  and never fails to build a scope for a valid IR (schema-fed issues surface later, as `qualify.ts`
  `Diagnostic` kinds `unknown-table`/`unknown-column`/`ambiguous-column`/`unknown-field` — a materially
  different concept, not a structural scope-building failure).

**Verdict (mapWarnings): REWRITE-SUBSTANTIAL** — `syntax_error` maps cleanly; `scope_warning` likely just
disappears (flagged as open question, not assumed).

---

## 8. `jinja-token-enrichment.ts` — `enrichTokensWithJinjaSpans`

Mutates `tokens`/`refs`/`sources` in place after AST extraction: expands a `table_ref` token's `endCol` to
cover the full `{{ ref(...) }}` span, and back-fills `RefInfo.alias`/`SourceInfo.alias` from the matching
AST-derived token (since jinja-side extraction can't see SQL aliases) (`jinja-token-enrichment.ts:13-36`).

The cross-referencing logic (match by name + line + col) is shape-independent of the parser — it just
needs a `table_ref`-shaped token to mutate, whatever produces it.

**Verdict: REWRITE-SMALL** (logic is unchanged; only the upstream token shape it mutates changes from
`TableRefToken` built by `tokens-extractor.ts` to whatever the sqllens-native replacement emits).

---

## 9. `sql-paren-utils.ts` — `findCteDef`, `findMatchingParen`, `isPositionInComment`

Byte-level scanners over raw SQL, built because "sqlglot's `_meta` carries only token start positions"
(`sql-paren-utils.ts:1-8`) — used by `cte-extractor.ts` to locate a CTE's closing paren.

As shown in section 1, `CteDef.cst.stop` gives that position directly — no byte scan needed for that
call site. `findCteDef`/`isPositionInComment` have a **second consumer** outside the extractor pipeline:
`src/dbt/cte-test-generator.ts:9,185,212` (dbt unit-test scaffolding, operating on already-compiled SQL
text, independent of `DocumentModel`) — out of scope for this migration phase but worth flagging so the
file isn't deleted wholesale.

**Verdict: DELETE** (for the `cte-extractor.ts` call site); file itself likely **KEEP** for
`cte-test-generator.ts` unless that feature is migrated too (not part of this census).

---

## 10. `index.ts` — barrel re-export

Pure re-export surface, no logic. Rewritten mechanically once the underlying functions move/disappear —
no independent verdict.

---

## Supporting module: `ast-utils.ts` (not in `extractors/`, but load-bearing for all of them)

`childOf`, `findAll`, `expressionsOf`, `leafValue`, `identifierName`, `identifierPosition`,
`innermostScope`, `isDescendantOf`, `findDescendant(s)`, `unwrapToSelect`, `findPositionedIdentifier` — a
generic flat-array (`AstPayload[]`) search toolkit standing in for the fact that sqlglot's `serde.dump()`
payload has no typed tree, only parent-index/arg-key linkage.

sqllens's IR is an actually-typed tree (`QueryExpr`/`SelectExpr`/`Expr` discriminated unions) — every one
of these generic walkers becomes a direct field access or a `switch` on `.kind`, per every table above.

**Verdict: DELETE** in its entirety once every extractor is rewritten against the typed IR.

---

## DocumentModel fields no extractor populates

| Field | Actually set by | Note |
|---|---|---|
| `timing` | `ftl-document-parser.ts:140`, straight from `result.timing` | Parser-native, not extractor logic |
| `status` | `parse-service.ts` `_parse()`, derived from whether `sqlglotWarnings` contains a `syntax_error` | Orchestration, not extraction |
| `aliases` | **Nothing, currently.** `FtlDocumentParser.parse()`'s returned object (`ftl-document-parser.ts:131-148`) has no `aliases` key, and `ParseResult` (`parse-result.ts:68-89`) declares no `aliases` field either — despite `DocumentModel.aliases` (`parse-service.ts:294-298`) and `ParseService`'s own doc comments ("Alias → column-name map returned by the bridge after schema-aware parsing") describing it as bridge-populated. This looks like a **dead/vestigial field** on the current sqlglot path — verify before assuming sqllens needs to reproduce it | Flagged as a finding, not a guess — grep of `src/ftl` for `aliases` turns up no assignment site outside this comment |
| `jinjaTokens` | Passthrough of `result.jinjaTokens`, produced by the TS jinja tokenizer | Not AST-derived |
| `ninjaSqlTokens` | `mergeSqlAndJinjaTokens` (`src/ftl/ninja-sql-tokens.ts`, outside `extractors/`), from `result.sqlTokens` + `result.jinjaTokens` | Separate merge utility, not reviewed here in depth |
| `ast` | Passthrough of `result.ast` (the raw sqlglot payload) | This is exactly the field the plan's new `AstIndex` (over IR/CST) replaces — its presence on `DocumentModel` is itself sqlglot-shaped and should disappear with the printer's new backing |
| `isPass2` | Passthrough of `result.isPass2` | Parser-native, not extractor logic |

---

## Open questions / mismatches

1. **Line/col basis mismatch inside the current codebase itself**, independent of sqllens: `AstPayload.m.line`
   is 1-based while `SqlToken.line` is 0-based (see convention note at the top) — a pre-existing
   inconsistency the sqllens rewrite gets to retire (sqllens is uniformly 1-based line / 0-based column
   everywhere: IR spans, tokens, diagnostics).
2. **Alias-identifier span not modeled as a distinct IR field.** `Projection` (`ir.ts:348-355`) carries one
   `cst` for the whole projection (`expr AS alias`), not a separate span for just the alias token. Both
   `CteInfo.columns[].col` (section 1) and `column_def` tokens (section 2) rely on that distinction today
   (to position hover/rename targets exactly on the alias identifier, not the whole expression). This is
   the same *category* of gap as the plan's named "per-part column-ref spans" blocker, but on a different
   node type — not currently tracked in `sql-dialect-grammars/docs/PLAN.md` as far as this census could
   tell without a deeper read of that repo. Worth raising there if per-token precision matters for
   hover/rename on aliases (as it clearly does for column qualifiers).
3. **Table-name per-part span unconfirmed.** `TableSource.name: string[]` (`ir.ts:414-429`) has one `.cst`;
   whether that `cst` spans just the table's own identifier or the full multipart name (`catalog.schema.table`)
   was not verified against a specific dialect's `lower.ts` in this pass — flagged rather than assumed.
4. **`scope_warning` has no sqllens analog** (section 7) — `resolveScopes()` is total; the sqlglot-era
   "can't analyse a CTE scope" failure mode may simply not exist in the new pipeline. Needs a decision:
   drop the warning type, or find what schema-free condition (if any) should replace it.
5. **Lineage tree shape gap** (section 4) is the single largest gap found outside the plan's two named
   blockers (Join nodes, per-part column spans) — sqllens's `lineage()` gives flat base-table origins, not
   the current per-CTE transformation tree with union branches. This should probably be raised as a third
   Phase-0 precondition if the Lineage & Impact panel's transformation view is in scope for the initial cutover.
6. **`pivotVirtualColumns` may be redundant** (section 5) once `CteInfo.columns` is sourced from
   `Qualification.columnsOf()`, which already includes pivot/unpivot-produced columns. Decide during the
   `cte-extractor` rewrite rather than porting the field by default.
7. **`aliases` field is likely dead code today** (see table above) — confirm with a grep/test before
   deciding sqllens needs to reproduce it at all.

---

## Verdict tally (extractor units, not DocumentModel fields — a unit with mixed sub-verdicts counts under its dominant one)

| Verdict | Units |
|---|---|
| DELETE | `column-expr-helpers.ts`, `pivot-extractor.ts`, `ast-utils.ts`, `sql-paren-utils.ts` (cte-extractor call site only) |
| REWRITE-SMALL | `final-select-extractor.ts`, `jinja-token-enrichment.ts`, subquery/table_ref half of `tokens-extractor.ts` |
| REWRITE-SUBSTANTIAL | `cte-extractor.ts`, `lineage-walker.ts`, `mapWarnings` (in `jinja-tag-extractors.ts`) |
| BLOCKED | column-qualifier half of `tokens-extractor.ts` (per-part column-ref spans — named Phase-0 blocker) |
| KEEP (jinja-side) | `extractRefs`/`extractSources`/`extractMacroCalls` (in `jinja-tag-extractors.ts`) |

7 files/units total, excluding the pure barrel `index.ts`.
