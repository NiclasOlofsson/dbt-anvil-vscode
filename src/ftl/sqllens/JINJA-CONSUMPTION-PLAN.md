# Jinja layer → sqllens-native-jinja consumption plan

The extension-side counterpart to sqllens's forthcoming jinja-grammar spec (sql-dialect-grammars
`docs/anvil/CHANNEL.md` ITEM 10 / 11 / 14 — the LOCKED two-path + one-seam + one-razor design). This
is the sibling of `EXTRACTOR-MAP.md`: where that maps each SQL-AST extractor to its sqllens IR source,
this maps each piece of the **jinja** layer to its fate once sqllens parses raw jinja-SQL natively and
answers dbt questions through a pull-callback. Same rules: a verdict per piece, precise file refs, and
a fate for each unit.

The layer being replaced is **2,571 LOC** across 13 files (verified `wc -l`, 2026-07-04) — the three
non-interoperating jinja implementations, two tokenizers, and one regex stripper catalogued in the
CHANNEL ITEM 14 opener. Every one of them exists for a single reason: the SQL parser (sqlglot, now
sqllens) could not see jinja, so each consumer invented its own way to get jinja out of the way.

The locked model in three lines (CHANNEL ITEM 14, 2026-07-04 "LOCKED requirements stance" + overnight
Q3 resolution):

- **TWO PATHS.** EDIT-TIME: sqllens parses raw jinja-SQL, a macro expansion is a TYPED HOLE, it NEVER
  renders. VALIDATION-TIME: the extension renders via REAL dbt (`bridge.py compile_inline`) and feeds
  clean compiled SQL back to sqllens as plain SQL. Rendering is OUT of sqllens.
- **ONE SEAM.** A pull-callback `TemplateCatalog` (generalizes the existing `CallbackSchema` /
  `SchemaSource`, re-exported from `src/ftl/sqllens/api.ts:27,57`): sqllens asks, the extension answers
  from dbt knowledge, defaults fill gaps. Two timing regimes — lazy post-parse resolution, up-front
  synchronous parse-time shape.
- **ONE RAZOR.** In-text STRUCTURAL work is sqllens's (parse, tokens/AST, typed holes, control-flow
  regions, **variant expansion** — Q3 resolved: it is parsing, so it moves to sqllens). Out-of-text DBT
  KNOWLEDGE is the extension's (macro output-shape, loop collections, ref/source/var, rendering).

Staged increments (CHANNEL ITEM 14): **inc1** placeholder-parity (raw-jinja-parse; delete the blanking
cascade; R1/R2 spans), **inc2** tag-AST (R3 templated-refs-as-FROM-nodes, R4 control-flow + set/macro
symbols, variant expansion relocates), **inc3** TemplateCatalog wiring (resolution + shape + loop
collections). Each increment is independently shippable and gated behind the parse engine switch.

Position-convention note (as in EXTRACTOR-MAP): the whole jinja layer works in **0-based offsets** and
**0-based line / 0-based start col / 0-based exclusive end col** (`jinja-tokenizer.ts:37-43`,
`jinja-spans.ts`), and every `RefInfo`/`SourceInfo`/`MacroCallInfo` field is documented 0-based
(`parse-service.ts:37-114`). sqllens is 1-based line / 0-based column (`token.ts:33-36`). The R2
acceptance contract below is stated in the extension's 0-based convention; the `line - 1` conversion is
the consumer's, same as every other sqllens field.

---

## Fate table (the census)

| File | LOC | Current role | Fate | Subsumed by |
|---|---|---|---|---|
| `src/ftl/parse-with-jinja-fallback.ts` | 50 | 3-pass cascade orchestrator (blank-id → blank-comment → nunjucks) | **DELETE** | inc1 / R1 (raw-jinja-parse — no fallback needed) |
| `src/dbt/jinja-blanker.ts` | 247 | length-preserving `blankJinja` + `iterJinjaTags` — the placeholder primitive | **DELETE** | inc1 / R1 (no blanking; sqllens sees raw jinja) |
| `src/ftl/nunjucks-renderer.ts` | 167 | pass-2 nunjucks stub render + `lineMap` | **DELETE** (Q4-gated) | inc1 / validation-path = real dbt render via bridge |
| `src/dbt/sql-variant-generator.ts` | 107 | `{% if %}` variant enumerate-and-space-mask | **RELOCATE-TO-SQLLENS** | inc2 / R4, Q3 (variant expansion is parsing) |
| `src/dbt/branch-enumerator.ts` | 181 | branch-tree build + variant count/select | **RELOCATE-TO-SQLLENS** | inc2 / R4, Q3 |
| `src/dbt/jinja-tokenizer.ts` | 180 | coarse 4-kind tokenizer (feeds variant expansion) | **RELOCATE-TO-SQLLENS** | inc2 / R1 native tokens drive native variant expansion |
| `src/ftl/jinja-tokenizer.ts` | 219 | fine 15-kind tokenizer (feeds extraction/merge/debug) | **DELETE** | inc1 / R1 (one unified token stream) |
| `src/ftl/jinja-spans.ts` | 33 | offset ↔ line/col pure math | **KEEP** | parser-independent (only surviving unit) |
| `src/ftl/extractors/jinja-tag-extractors.ts` | 250 | `extractRefs`/`extractSources`/`extractMacroCalls` (+`mapWarnings`) | **DELETE** | inc2 / R2 (parsed nodes with arg spans) |
| `src/ftl/extractors/jinja-token-enrichment.ts` | 36 | cross-ref jinja spans onto SQL tokens (alias back-fill, full span) | **DELETE** | inc2 / R3 (templated ref is a native FROM node) |
| `src/ftl/ninja-sql-tokens.ts` | 118 | `mergeSqlAndJinjaTokens` interleave + drop-inside-jinja | **DELETE** (2 helpers REWRITE-SMALL) | inc1 / R1 (one stream, no merge) |
| `src/dbt/debug-symbols.ts` | 909 | `@dbg` comment weave + `parseSourceMap` (debugger source map) | **DELETE** (staged) | inc1→inc2 / I2 (native Source Map) |
| `src/providers/common/jinja-utils.ts` | 74 | `stripJinja` regex schema-hint stripper | **REPLACE-WITH-CALLBACK** | inc3 / ITEM 11 (`TemplateCatalog.relation`) |
| `parse-service.ts` `mergeModels` + `generateVariants` call site | — | variant-merge glue (`parse-service.ts:369,915,934`) | **RELOCATE-TO-SQLLENS** | inc2 / R4, Q3 (single parse call) |

13 files + the ParseService glue site. Tally at the bottom.

---

## 1. `parse-with-jinja-fallback.ts` — the cascade orchestrator — DELETE (inc1)

Runs three passes (`parse-with-jinja-fallback.ts:39-49`): `blankJinja` identifier mode → `blankJinja`
comment mode → `renderForParse` nunjucks. Each pass exists purely because the parser needs syntactically
valid SQL and can't tolerate `{{ }}`. R1 ("ONE unified token/AST stream over RAW jinja-SQL") removes the
precondition entirely — sqllens is total on raw jinja-SQL (R5: error-tolerant, same mandate as its SQL
`lower()` totality), so there is nothing to fall back FROM. The `ParsePass`/`ParseWithFallbackResult`/
`idMap` types die with it. **DELETE.** The one surviving concept — "when the assembled query is too
dynamic to analyze statically, render it for real" — is not a parser fallback; it is the VALIDATION-TIME
path (real dbt via the bridge), which is orchestrated elsewhere and answers a different question.

## 2. `jinja-blanker.ts` — the placeholder primitive — DELETE (inc1)

`blankJinja` (`jinja-blanker.ts:156-247`) and `iterJinjaTags` (`:27-72`) are the core of the workaround:
length-preserving substitution so downstream offsets survive. The whole reason for its existence is
gone under R1. Notable internal knowledge that does NOT need porting — sqllens absorbs it:

- The `STATEMENT_MACROS` set (`:89`) that blanks `config`/`docs`/`print`/`log`/`return`/`exceptions` to
  spaces because they produce no SQL output — this becomes an `expansionShape → undefined`/no-output
  classification on the extension side of the TemplateCatalog (§4), or a built-in signature.
- The identifier-vs-comment macro modes (`:148-155`) that fight statement-level vs expression-level
  placement — this is exactly the "a placeholder can't fuse with adjacent tokens" problem that the
  typed-hole shape (`'expr'|'column-list'|'predicate'|'relation'|'statement'`) solves properly (CHANNEL
  ITEM 14, "WHY holes need shape").
- The nested-`{{ }}` depth scanner (`:37-49`) and string-aware close-finding — subsumed by a real
  grammar.

**DELETE** — but note the ordering: `iterJinjaTags` is imported by `jinja-tokenizer.ts` (both), by
`nunjucks-renderer.ts:2`, and by `debug-symbols.ts:1`. It is the last thing to physically remove, once
every one of those consumers is gone (it clears inc1 for the tokenizers/renderer; the debug-symbols
consumer clears in the staged §3 work).

## 3. `nunjucks-renderer.ts` — pass-2 stub render — DELETE, Q4-gated (inc1)

`renderForParse` (`:151-167`) runs a real nunjucks render with a Proxy that stubs every unknown macro to
`__jinja__` and maps known dbt globals to SQL-safe values (`:25-50`), plus a `lineMap` bisect
(`:69-123`) to walk rendered positions back to source. It is the escape hatch for templates too dynamic
to blank.

Under the locked model, static analysis of what-the-user-wrote is EDIT-TIME (sqllens, holes, no render),
and any real render is VALIDATION-TIME via **real dbt** (`bridge.py compile_inline` — real macro defs +
manifest + deps), not a nunjucks stub approximation. The nunjucks render was always a lossy stand-in for
the render the bridge can now do correctly. **Fate: DELETE** — but this is **Q4** in the CHANNEL, still
formally open: "Does the nunjucks pass-2 fallback survive?" It survives only if there is a class of
input that (a) the typed-hole edit-time parse can't give useful feedback on AND (b) the bridge render
can't cover. The locked design's expectation is that (a)+(b) is empty, so nunjucks dies. Flagged in
Risks (§6) — this is the single fate in this doc gated on a not-yet-closed question.

## 4. Variant expansion trio — `sql-variant-generator.ts` + `branch-enumerator.ts` + `dbt/jinja-tokenizer.ts` — RELOCATE-TO-SQLLENS (inc2)

`generateVariants` (`sql-variant-generator.ts:89-107`) tokenizes with the coarse `dbt/jinja-tokenizer.ts`
`tokenize` (`:27-136`), builds a branch tree (`branch-enumerator.ts:64-108`), and emits one
length-preserving SQL string per `{% if %}/{% elif %}/{% else %}` combination (`countVariants`/
`selectVariant`, `:118-169`), space-masking inactive arms so offsets survive. ParseService then parses
each and merges by byte range (`parse-service.ts:915-934`).

Q3 is **resolved** (CHANNEL 2026-07-04 overnight, Niclas): *"variant expansion BELONGS IN sqllens — if
you can do it, you should, because it is parsing."* For the editor, sqllens enumerates ALL branches
structurally with NO condition evaluation (the user edits every arm regardless of which runs), preferring
genuine per-branch coherent variants over a single merged region tree (a merged tree with two alternative
WHEREs is incoherent — exactly why our `mergeModels` can only query by byte-range, never traverse). So
this is not a rewrite on our side: the responsibility **relocates across the repo boundary**. sqllens
owns the enumeration natively (from its own token/region model, R4), and the three TS files are deleted.
The coarse `dbt/jinja-tokenizer.ts` in particular has no life outside driving these two — it exists only
because we needed a cheap branch-structure scan; sqllens's native tokens (R1) replace it whole.

Where sqllens **can't** expand cleanly alone, the SAME callback helps (CHANNEL overnight): `{% if %}` =
both arms in text, no help; `{% for x in [1,2,3] %}` = literal, no help; `{% for col in columns %}` where
`columns` is a var/macro/schema = sqllens pulls the collection from the TemplateCatalog (§4), defaulting
to a representative iteration. That collection-pull is an extension responsibility (§4 loop-collections).

## 5. `ftl/jinja-tokenizer.ts` — fine 15-kind tokenizer — DELETE (inc1)

`tokenizeJinja` (`:68-99`) emits the 15-kind stream (`JinjaTokenType`, `:17-32`) with per-token
`start`/`end`/`line`/`col` and the `tagEnd` skip-hint (`:44-57`) that feeds extraction (§7), the merge
(§8), and the debugger. R1 delivers ONE unified token/AST stream over raw jinja-SQL in source coords,
which is precisely this stream plus the SQL tokens plus correct multi-line handling. **DELETE** —
consumers move to sqllens's unified stream (the `JinjaToken` type itself, re-exported from many places,
is retired along with it).

## 6. `ftl/jinja-spans.ts` — offset↔line/col math — KEEP (parser-independent)

`buildLineStarts`/`lineAtOffset`/`colAtOffset` (`:10-33`) are pure text math, no jinja and no parser
dependency. This is the answer to "does anything survive?" — **yes, this and only this**. Today it is
consumed by the jinja tokenizer, the CTE extractor, and the debug-symbol emitter. Those consumers change
or die, but offset↔line/col conversion remains generically useful anywhere the extension holds a raw
offset and needs an editor position (e.g. mapping a sqllens span into a VS Code `Position`, or the debug
adapter's own coordinate work). **KEEP.** Caveat: if every last consumer is rewritten to take sqllens's
already-line/col spans directly, this becomes orphaned and can be dropped — a trivial cleanup, not a
migration concern.

## 7. `extractors/jinja-tag-extractors.ts` — ref/source/macro extractors — DELETE (inc2)

`extractRefs` (`:38-71`), `extractSources` (`:79-118`), `extractMacroCalls` (`:143-240`) pattern-match
the fine jinja token stream to pull `{{ ref(...) }}`, `{{ source(...) }}`, and `{{ pkg.macro(...) }}`
with exact span fields (they never touch SQL AST). R2 makes these **parsed nodes with arg spans** —
sqllens's jinja tag-AST carries ref/source/macro as first-class nodes. **DELETE.** The span fields these
produce are the HARD acceptance contract R2 must satisfy — see the contract in the next section; they
are not optional niceties, providers position hover/rename/signature-help exactly on them today.

`mapWarnings` (`:242-250`) lives in this file but is not jinja — it maps SQL-side `ParseWarning` to
`SqlglotWarning`. Its fate is covered by EXTRACTOR-MAP §7 (REWRITE-SUBSTANTIAL: `syntax_error` maps to
sqllens `SyntaxDiagnostic`, `scope_warning` likely disappears), not here. It does not ride the jinja
increments.

## 8. `extractors/jinja-token-enrichment.ts` — jinja↔SQL cross-ref — DELETE (inc2)

`enrichTokensWithJinjaSpans` (`:13-36`) mutates SQL tokens after AST extraction: expands a `table_ref`
token's `endCol` to cover the whole `{{ ref(...) }}` span and back-fills `RefInfo.alias`/`SourceInfo.alias`
from the matching AST token (jinja-side extraction can't see SQL aliases). R3 ("templated relations as
first-class FROM/IR nodes") makes both mutations unnecessary: the `{{ ref('x') }}` in a FROM/JOIN slot
lowers to ONE table-source IR node that already carries the tag span AND participates in the FROM clause,
so its alias is native (same way `TableSource.aliasCst` already carries a real alias span on the SQL
side, EXTRACTOR-MAP §2). No post-hoc cross-referencing. **DELETE.**

## 9. `ninja-sql-tokens.ts` — the two-stream merge — DELETE, 2 helpers REWRITE-SMALL (inc1)

`mergeSqlAndJinjaTokens` (`:73-93`) interleaves SQL and jinja tokens by offset and DROPS SQL tokens that
fall inside jinja regions (`dropSqlInsideJinja`, `:108-118`) — because the SQL lexer was seeing the
blanker's placeholder text (`VAR(__j0__)`) and its tokens there are garbage. R1's unified stream is born
correct: there are no placeholders, so there is nothing to drop and nothing to interleave — sqllens emits
SQL and jinja tokens in one ordered stream already. **DELETE the merge.**

The two *accessor helpers* are consumed by ninja rules / the formatter and need a native equivalent:
`sqlOnly` (`:37-42`) filters the `category === 'sql'` view, and `jinjaLeadingLines` (`:52-62`) computes
lines whose first content token is jinja (indent rules skip them). These are **REWRITE-SMALL** against
sqllens's unified stream — the same predicates over sqllens's `category`/channel discriminator instead of
our `NinjaSqlToken` union. The `NinjaSqlToken` tagged-union type retires; the two queries survive as
thin views on the native stream.

## 10. `providers/common/jinja-utils.ts` — `stripJinja` — REPLACE-WITH-CALLBACK (inc3)

`stripJinja` (`:18-74`) is the THIRD, regex-only jinja remover: it rewrites `{{ ref('m') }}` →
`schema.table` and `{{ source('a','b') }}` → `schema.identifier` by looking the name up in the
`ManifestIndexer` (`:27-40,48-59`), then blanks remaining tags, producing SQL that carries real relation
names for the qualify schema hint. This is dbt KNOWLEDGE resolution done inline with a regex — precisely
what the **TemplateCatalog** seam replaces (CHANNEL ITEM 11). Under inc3, sqllens parses the `{{ ref }}`
node and PULLS its relation from the extension via `TemplateCatalog.relation(call) → { nameParts,
columns? }`; the manifest lookup that lives inside `stripJinja` today becomes the body of that callback.
**REPLACE-WITH-CALLBACK** — the regex/blank machinery is deleted, the `ManifestIndexer` lookup logic
relocates into the catalog implementation (§4). This is the cleanest example of the razor: the WORLD
knowledge (what `ref('m')` resolves to) stays extension-side, just behind a pull interface instead of a
pre-pass string rewrite.

## 11. ParseService glue — `mergeModels` + `generateVariants` call site — RELOCATE-TO-SQLLENS (inc2)

`parse-service.ts:915` calls `generateVariants(rawText)`, parses each variant, and `mergeModels`
(`:369`) unions the per-variant models by byte range (`:934`). With variant expansion relocated to
sqllens (§4), the fast/slow split (`:918-935`) collapses: ParseService makes **one** parse call on raw
jinja-SQL and gets back a model that already covers every branch (sqllens owns the enumeration and the
union internally, or returns coherent per-variant products it composes). `mergeModels` and its
byte-range union policy die. **RELOCATE-TO-SQLLENS** — the call site simplifies to the single-parse fast
path for all inputs.

---

## R2 acceptance contract — the HARD span fields sqllens must emit

These are not derivable from a coarser node; providers position editor features exactly on them today.
They are the census's requirements ON sqllens R2, stated in the extension's 0-based convention
(`parse-service.ts:37-114`). sqllens's jinja tag-AST must carry a span for each, or the corresponding
provider feature regresses.

**ref node** (replaces `RefInfo`, `parse-service.ts:37-53`; produced today by `extractRefs`
`jinja-tag-extractors.ts:58-66`):

```
	model            string   — model name (string-literal content, quotes excluded)
	line, col                 — 0-based line + start col of the ref() call
	modelCol         span     — start col of the model-name string content (quotes EXCLUDED)
	modelEndCol      span     — exclusive end col of the model-name content
	jinjaCol         span     — start col of the whole {{ ref(...) }} tag
	jinjaEndCol      span     — exclusive end col of the whole tag
	alias            —          SQL alias (was back-filled §8; native under R3 FROM node)
```

**source node** (replaces `SourceInfo`, `:55-76`; today `extractSources` `:102-113`):

```
	sourceName, tableName     — the two string-literal contents
	sourceNameCol / …EndCol   — schema-arg content span (quotes excluded)
	tableNameCol / …EndCol    — table-arg content span (quotes excluded)
	jinjaCol / jinjaEndCol    — whole {{ source(...) }} tag span
	alias                     — SQL alias (native under R3)
```

**macro-call node** (replaces `MacroCallInfo`, `:87-114`; today `extractMacroCalls` `:213-231`) — the
richest, drives signature help:

```
	name                      — bare macro name
	packageName + packageCol/packageEndCol   — pkg qualifier span for pkg.macro(...)
	line, col, endCol         — bare macro identifier span
	jinjaLine/jinjaCol/jinjaEndCol           — enclosing {{ }} OR {% %} tag span
	argsCol / argsEndCol      — opening-paren col / closing-paren exclusive-end col
	args: MacroCallArgInfo[]  — PER-ARGUMENT span {line,col,endCol}, source order,
	                            top-level-comma split (nested parens respected),
	                            supporting outer(inner(...)) and pkg.macro(...)
```

Additional R2 requirements the current extractors document as unmet (a real parser must fix, CHANNEL
ITEM 14 R2): **multi-line tags** — `extractRefs`/`extractSources` explicitly assume single-line and are
lossy across newlines (`jinja-tag-extractors.ts:33-37`); sqllens must return correct spans across a
newline inside a tag. `extractMacroCalls` already handles multi-line via absolute offsets (`:129-131`)
and is the shape to match. **var/env_var/config recognition**: `config/docs/print/log/return/exceptions`
produce no SQL output; `var/env_var` produce a value (today encoded in `jinja-blanker.ts:89` and the
nunjucks Proxy `:29-31`) — these classifications must survive as node kinds or catalog-shape inputs.

Where each `DocumentModel` field is sourced after the cutover:

| DocumentModel field | Today | After (sqllens-native) |
|---|---|---|
| `refs` / `sources` | `extractRefs`/`extractSources` over jinja tokens | R2 ref/source tag-AST nodes (inc2) |
| `macroCalls` | `extractMacroCalls` (`parse-service.ts:281`) | R2 macro-call tag-AST nodes (inc2) |
| `jinjaTokens` | `tokenizeJinja` passthrough (`:304`) | R1 unified stream, jinja-channel view (inc1) |
| `ninjaSqlTokens` | `mergeSqlAndJinjaTokens` (`:313`) | R1 unified stream directly — no merge (inc1) |
| `isPass2` / `ParsePass` | which cascade pass succeeded | **removed** — no cascade (inc1) |

---

## The debugger path — @dbg comment-weave → native Source Map (I2)

`debug-symbols.ts` (909 LOC — the single largest file in the layer) is a hand-rolled source map smuggled
through SQL comments. Today's round-trip: `injectMarkers` (`:134`) weaves `/* @dbg:L:C:role */` comment
markers into the source at symbol positions, dbt compiles the annotated source (macros expand, markers
ride along inside the compiled SQL), and `parseSourceMap` (`:268`) re-reads the markers out of the
compiled SQL (`MARKER_OPEN_RE`, `:71-72`) to reconstruct compiled↔source position mappings for CTE
stepping. The wire path that is actually live in the debug adapter is
`emitDebugSymbolsFromTokens` (`:521`) → dbt compile → `parseSourceMap` (`debug-adapter.ts:12,2411,2422`).

**The improvement (CHANNEL I2):** if sqllens OWNS the jinja→SQL transformation (variant expansion +
templated-node lowering), it can emit source↔expanded position mappings **directly** (a real
Source-Map-v3-shaped artifact), replacing the entire comment-weave round-trip. CHANNEL calls I2 "the
single biggest maintenance win" — 909 LOC of marker weaving/parsing collapses to consuming a mapping
sqllens hands over.

**Already-built seam, not yet wired.** A sqllens/`Sym`-based emit path already exists in the file:
`emitDebugSymbols` (`:802-...`) derives symbols from sqllens's semantic `Sym` model (idents/functions)
plus its lexical token stream (clause keywords/star/literals), and derives frames from `Sym.frame` via
`buildFrameRanges` (`:731-750`) — replacing the hand-rolled CTE-range walk. It has its own test suite
(`debug-symbols.sqllens.test.ts`, incl. a `emitDebugSymbols` vs `emitDebugSymbolsFromTokens` frame-parity
block, `:189`). But it is **NOT called from `debug-adapter.ts`** — the adapter still uses
`emitDebugSymbolsFromTokens`. `emitDebugSymbols` reuses the SAME wire format (`injectMarkers` /
`parseSourceMap` unchanged, per its header `:690-692`); it still blanks (`analyzeBlanked`) and still
weaves markers — it is a better SYMBOL SOURCE, not yet the native source map.

**Staged replacement:**

- **inc1/inc2 (transitional).** Wire `emitDebugSymbols` (the Sym-based path) into `debug-adapter.ts` in
  place of `emitDebugSymbolsFromTokens`. Symbols and frames now come from sqllens's semantic model
  instead of the token weave; the marker round-trip and `parseSourceMap` still stand. This deletes the
  `emitDebugSymbolsFromTokens` half and its `TOKEN_ROLE_MAP` machinery. It is doable **before** sqllens
  owns rendering, because it only changes where symbols come from.
- **inc2+/I2 (target).** Once sqllens owns the jinja→SQL transform, it emits the compiled↔source mapping
  directly. `injectMarkers` (`:134`), the `MARKER_*` regexes (`:71-72`), `parseSourceMap` (`:268`), and
  the whole `EmitResult`/`BridgeMacroSpan` marker apparatus (`:655-683`) are **DELETED**. What remains is
  a thin adapter that consumes sqllens's mapping into the `SourceMap` interface (`:56-69`) the debug
  adapter already reads (`sourceToCompiled`/`compiledToSource`/`compiledLineToSourceLine`/`isInsideMacro`,
  `debug-adapter.ts:2247`). That interface is the stable boundary; its producer swaps from
  marker-parsing to sqllens-mapping-consumption.

Net: **DELETE (staged)**. `findJinjaSpans`/`SymbolEntry`/frame-range helpers may survive briefly as glue;
the marker-weave core dies at I2. Keep `jinja-spans.ts` (§6) — the debug adapter's own offset math uses
it independent of the marker path.

---

## The TemplateCatalog the extension must implement (inc3, ITEM 11)

The one seam. It generalizes the existing `CallbackSchema` / `SchemaSource` pattern (already re-exported
from `src/ftl/sqllens/api.ts:27,57` and used for SQL schema pull) to the jinja layer: ref/source/var/
macros are to the template layer what the schema is to SQL — external catalog knowledge, injected through
a pull interface. sqllens stays dbt-unaware; the extension answers. Two timing regimes (CHANNEL ITEM 14
locked stance):

```
	interface TemplateCatalog {
		// LAZY post-parse resolution — async, cached, versioned like SchemaSource.
		// Diagnostics/lineage republish when a warm answer arrives.
		relation(call): { nameParts: string[]; columns?: string[] } | undefined   // ref() / source()
		value(call): Type | undefined                                             // var() / env_var()

		// UP-FRONT parse-time shape — SYNCHRONOUS, by-name. sqllens can't pause
		// mid-lex to await; the shape must be answerable while the tree is built.
		expansionShape(macroCall):
			'expr' | 'column-list' | 'predicate' | 'relation' | 'statement' | undefined

		// UP-FRONT loop collections — for {% for x in <external> %} where the
		// collection isn't a text literal (var/macro/schema-derived).
		loopCollection(forCall): unknown[] | undefined
	}
```

Where each answer comes from, extension-side (sqllens unaffected — how we ANSWER is entirely ours and
upgrades per-macro without sqllens changing):

| Callback | Source in the extension |
|---|---|
| `relation(ref/source)` | `ManifestIndexer` (`findModelsByName`, `getRawNode` — the exact lookups inside `stripJinja` today, `jinja-utils.ts:27-59`) for the relation name; `DescribeCache` for `columns` |
| `value(var/env_var)` | dbt project vars / `env_var` resolution (the nunjucks Proxy's `var`/`env_var` handling `nunjucks-renderer.ts:30-31` becomes real project lookups) |
| `expansionShape(macro)` | (1) built-in macro signatures (`dbt_utils.star → column-list`, etc.); (2) the `dbt-anvil.macroShapes` user setting; (3) a code-action/quick-fix that writes the setting |
| `loopCollection(for)` | dbt var / manifest / schema column list; unknown/runtime → sqllens expands a representative iteration |
| render (validation path) | `bridge.py compile_inline` — real dbt render; the escape hatch that lets `expansionShape` upgrade v1 positional-default → v2 signature → v3 real-render of one macro |

**Optional over defaults** (the keystone that makes this safe to ship early): `expansionShape → undefined`
falls back to sqllens's positional guess (a callable in a column slot → identifier). A ZERO catalog still
parses (defaults everywhere); with a catalog it parses precisely. Editor-native: works before the
manifest loads, sharpens as we feed it more. Rendering is a CATALOG RESPONSE, not an architecture —
power (render, deps, manifest) lives entirely extension-side behind this one seam.

**User-facing shape population** (CHANNEL ITEM 14, extension-side, sqllens unaffected): `expansionShape`
comes from (a) built-in signatures, (b) `dbt-anvil.macroShapes` (`{ "my_org.build_where": "predicate" }`
— the sqlfluff-config equivalent for a user's own macros), and (c) a **code-action / quick-fix**: an
unshaped macro that degrades the parse surfaces a diagnostic with a one-click "this macro produces
[column-list|predicate|expr|relation]" that writes the setting. The one sqllens ask that enables the
quick-fix: the hole node carries its **syntactic-slot context** (the slot it sits in) so the extension
pre-fills the smart default — sqllens confirmed (CHANNEL 05:10) it bakes this in as a first-class field.

---

## Increment mapping (what dies/relocates at each stage)

Each increment is independently shippable and gated behind the parse-engine switch, so integration is
mechanical as sqllens ships.

**inc1 — placeholder-parity / raw-jinja-parse (R1, R2 spans).** sqllens parses raw jinja-SQL and returns
the unified token stream + ref/source/macro nodes with the R2 span contract. Delete on this increment:
`parse-with-jinja-fallback.ts` (§1), `jinja-blanker.ts` (§2, once its last consumers clear),
`nunjucks-renderer.ts` (§3, Q4-gated), `ftl/jinja-tokenizer.ts` (§5), `ninja-sql-tokens.ts` merge (§9).
`jinjaTokens`/`ninjaSqlTokens`/`isPass2` re-sourced (§ contract table). Debugger: wire the Sym-based
`emitDebugSymbols` (§3-debug transitional). This is the biggest single LOC drop and the natural first
increment (CHANNEL: "increment 1 = raw jinja-SQL parse + placeholder-parity so the blanking cascade can
start dying").

**inc2 — tag-AST (R3, R4) + variant expansion.** Templated refs become first-class FROM/IR nodes (R3):
delete `jinja-token-enrichment.ts` (§8) and `jinja-tag-extractors.ts` (§7, its nodes now native).
Control-flow + set/macro become structured nodes/symbols (R4): the variant trio
(`sql-variant-generator.ts` + `branch-enumerator.ts` + `dbt/jinja-tokenizer.ts`) RELOCATES to sqllens
(§4), and the ParseService `generateVariants`/`mergeModels` glue collapses to one parse call (§11).
Debugger moves toward the native Source Map as sqllens owns the transform (§3-debug target, I2).

**inc3 — TemplateCatalog wiring (ITEM 11).** The extension implements `TemplateCatalog` (§4):
`stripJinja` REPLACED-WITH-CALLBACK (§10), the manifest/describe/signature/setting/bridge sources wired
behind the pull interface, loop-collection pulls for external `{% for %}`. Resolution + shape + loop
collections all land here. This is the increment that turns "parses with defaults" into "resolves through
`{{ ref }}` with real columns pre-compile".

---

## Risks / open items

1. **Q4 — nunjucks pass-2 fate (§3).** The only fate in this doc gated on an open CHANNEL question. Tie:
   nunjucks dies iff the typed-hole edit-time parse + the real-dbt validation-path render cover every
   input the stub render covers today. Expected empty, so DELETE — but the escape hatch stays until the
   bridge's `compile_inline` is confirmed to cover the heavy-macro-body cases nunjucks was reached for.
   Decision belongs with the bridge coverage audit, not assumed here.

2. **Q1 macro-hole shape is the load-bearing sqllens fork, not ours — but our fates depend on it.** The
   typed-hole `expansionShape` set (`'expr'|'column-list'|'predicate'|'relation'|'statement'`) is what
   lets §2's statement-vs-expression placeholder problem retire cleanly. If sqllens's hole model lands
   materially different, the §4 TemplateCatalog `expansionShape` signature and the §2 `STATEMENT_MACROS`
   mapping shift with it. Decided-in-principle (CHANNEL: parse-with-holes, never render) but the grammar
   mechanics are unbuilt (spec-first, post parser-gaps wave).

3. **R2 multi-line span correctness is a genuine parity UPGRADE, not just a port.** `extractRefs`/
   `extractSources` are single-line-lossy today (`jinja-tag-extractors.ts:33-37`). sqllens R2 must be
   correct across newlines inside a tag — this is new behavior we are relying on, not reproducing, so it
   needs its own acceptance test in the cutover (the multi-line `extractMacroCalls` behavior `:129-131`
   is the bar).

4. **`ninja-sql-tokens.ts` helper parity (§9).** `sqlOnly`/`jinjaLeadingLines` are consumed by ninja
   rules and the formatter; they must be re-expressed on sqllens's unified stream with identical results
   or indent/format rules regress. REWRITE-SMALL, but the ninja rule suite is the gate.

5. **No clean sqllens home yet:** the **debugger native Source Map (I2)** is the one piece with no
   shipped sqllens surface — it depends on sqllens owning the jinja→SQL transform (variant expansion +
   templated-node lowering), which is inc2+ and unbuilt. Until then the debugger runs the transitional
   Sym-based `emitDebugSymbols` over the STILL-EXISTING marker round-trip (`injectMarkers`/
   `parseSourceMap`), so `debug-symbols.ts` is the last file to fully die, and part of it (the marker
   apparatus) has no sqllens replacement to consume yet. Everything else in the layer has a named R#/
   catalog home.

6. **`jinja-spans.ts` is the only genuine KEEP.** If the migration ends with every consumer taking
   sqllens line/col spans directly, it orphans — harmless, drop it then. Not a blocker.

---

## Verdict tally

| Fate | Units | LOC |
|---|---|---|
| **DELETE** | `parse-with-jinja-fallback.ts`, `jinja-blanker.ts`, `nunjucks-renderer.ts` (Q4-gated), `ftl/jinja-tokenizer.ts`, `jinja-tag-extractors.ts`, `jinja-token-enrichment.ts`, `ninja-sql-tokens.ts` (merge; 2 helpers REWRITE-SMALL), `debug-symbols.ts` (staged) | 50 + 247 + 167 + 219 + 250 + 36 + 118 + 909 = **1,996** |
| **RELOCATE-TO-SQLLENS** | `sql-variant-generator.ts`, `branch-enumerator.ts`, `dbt/jinja-tokenizer.ts`, ParseService `mergeModels`+`generateVariants` glue | 107 + 181 + 180 = **468** (+ glue) |
| **REPLACE-WITH-CALLBACK** | `jinja-utils.ts` `stripJinja` | **74** |
| **KEEP** | `jinja-spans.ts` | **33** |

**8 DELETE units (1,996 LOC), 3+glue RELOCATE units (468 LOC), 1 REPLACE-WITH-CALLBACK (74 LOC), 1 KEEP
(33 LOC).** Of 2,571 LOC surveyed, **~2,538 LOC is deleted or relocated out of the extension** (1,996
deleted outright + 468 relocated to sqllens + 74 collapsed into a callback body); only the 33-LOC pure
offset-math utility genuinely survives. The hardest open item is the debugger native Source Map (I2):
the only piece with no shipped sqllens surface, so `debug-symbols.ts` (909 LOC, 35% of the layer) dies
last and in two stages. The nunjucks render (§3, Q4) is the one fate not yet locked. And yes — one
corner of the current layer has no sqllens home yet: the debugger's marker round-trip
(`injectMarkers`/`parseSourceMap`), which waits on sqllens owning the jinja→SQL transform (inc2+).
