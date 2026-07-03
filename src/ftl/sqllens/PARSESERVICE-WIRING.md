# Wiring SqllensDocumentParser into ParseService — design doc

Next implementation step after the "sqllens behind the seam" build (Phase 1 of
`C:\Users\nicke\.claude\plans\using-this-alias-humming-beacon.md`). `SqllensDocumentParser`
(`src/ftl/sqllens/document-parser.ts`) and its supporting modules (`decompose.ts`,
`lineage.ts`, `token-mapper.ts`, `ast-index.ts`, `extract/*`) are already committed and
covered by `scripts/shadow-diff.ts`. This doc covers making the setting-gated live routing
real, informed by two capabilities that landed in sql-dialect-grammars' "editor-gold wave"
after the plan was written: `CallbackSchema`/`SchemaSource` (resolve-on-demand catalogs) and
`SqlDocument` statement cells (content-addressed per-statement parsing).

## 1. Current state

### 1a. What ParseService does today (`src/services/parse-service.ts`)

`ParseService` is constructed with one concrete `DocumentParser` (`src/services/document-parser.ts`)
and never swaps it:

```
constructor(
	private readonly _parser: DocumentParser,
	private readonly _logger: ILogger,
	private readonly _enrichment?: EnrichmentConfig,
) {}
```
(`parse-service.ts:547-551`)

`DocumentParser` (`document-parser.ts:23-29`) has one required method and two optional ones:

```
export interface DocumentParser {
	parse(sql: string, options?: ParseOptions): Promise<DocumentModel>;
	decomposeQuery?(compiledSql: string): Promise<string>;
	getDialectSymbols?(): Promise<DialectSymbols | undefined>;
}
```

`FtlDocumentParser` (`src/ftl/ftl-document-parser.ts`) implements all three, plus two methods
that are NOT on `DocumentParser`: `traceLineageV2` (`ftl-document-parser.ts:87-95`) and the
pool-lifecycle pair `ready()`/`dispose()` (`ftl-document-parser.ts:75-81`). Those extra methods
are why three call sites hold a concrete `FtlDocumentParser` reference instead of the
`DocumentParser` seam type — see §3.

Caching/enrichment shape, all in `parse-service.ts`:
- `_cache: Map<uri, {version, model}>` + `_inflight: Map<"uri@version", Promise>` (`:537-538`) —
  cache hit on unchanged `document.version`; concurrent same-version calls share one promise
  (`getDocumentModel`, `:577-605`).
- Schema enrichment (`_parse`, `:876-935`): before calling `this._parser.parse()`, it walks every
  jinja `ref`/`source` in the raw text (`stripJinja`, `:891`), and for each one **awaits**
  `describeCache.columns(uniqueId)` in parallel (`Promise.all`, `:894-902`) to build a flat
  `schema: Record<table, Record<column,type>>` map, passed as `ParseOptions.schema`. This is a
  synchronous-blocking-per-parse describe round-trip, not lazy.
- `invalidateEnrichmentFor(affectedIds)` (`:750-787`): linear scan of every cache entry's
  `refs`/`sources`, evicts the entry if any resolve to an affected uniqueId. Wired from
  `manifestWatcher.onEnrichmentInvalidated` (`extension.ts:475-477`).
- `evictUnenrichedDocuments()` (`:801-814`): evicts entries whose `model.refs.length > 0` but
  `model.aliases` came back empty — the "manifest wasn't loaded yet at parse time" case. Wired
  from `manifestWatcher.onIndexRebuild` (referenced in `extension.ts`, consumed by
  `EditorDiagnosticsProvider`).
- Last-good-model overlay on syntax error (`:937-948`): when the fresh parse has a
  `syntax_error` warning, the previous cached model's structural fields are kept and only
  `sqlglotWarnings`/`status`/`timing` are replaced — consumers never see structural data
  vanish on a typo.
- `getDocumentModel`'s outer try/catch (`:596-604`) already falls back to the **stale cached
  model** on any parser throw/crash, logging via `this._logger.error`. This is parser-agnostic —
  a `SqllensDocumentParser` throw is already caught here with no new code needed.

### 1b. Activation wiring (`src/extension.ts:464-472`)

```
const pyodideDir = path.join(context.extensionPath, 'node_modules', 'pyodide');
const vendorDir = path.join(context.extensionPath, 'resources', 'ftl', 'vendor');
const scriptsDir = path.join(context.extensionPath, 'resources', 'ftl');
const ftlParser = FtlDocumentParser.create(pyodideDir, vendorDir, scriptsDir, manifestIndexer, { logger });
await ftlParser.ready();
logger.info('Parse service: FTL worker pool ready');
const parseService = new ParseService(ftlParser, logger, { describeCache, indexer: manifestIndexer });
context.subscriptions.push(ftlParser);
```

`ftlParser.ready()` (`ftl-document-parser.ts:75-77`) awaits `PyodideWorkerPool`'s initial worker
boot: `minWorkers = min(4, cpus-1)` workers (`pyodide-worker-pool.ts:132-134`), each a full
WASM/CPython instance, raced against a 30s per-worker timeout (`:142-152`). Measured today:
`node_modules/pyodide` = 13M, `resources/ftl/vendor` (sqlglot) = 6.8M — ~20M, in the ballpark of
the plan's "18MB bundle" figure.

Beyond `ParseService`, the concrete `ftlParser` is also injected directly into:
- `registerLanguageModelTools(..., ftlParser, ...)` (`extension.ts:512`)
- `new GetColumnLineageTool(..., ftlParser)` (`extension.ts:527`, param typed
  `ftlParser: FtlDocumentParser` — `tools/get-column-lineage.ts:29`)

`GetColumnLineageTool` calls the concrete parser directly, **bypassing ParseService entirely**:
- `this.ftlParser.traceLineageV2(sql, columnName, schemaJson)` (`get-column-lineage.ts:451`)
- `this.ftlParser.parse(compiledCode, { schema: flatSchema })` (`get-column-lineage.ts:481`) —
  no cache, no variant expansion, its own local try/catch.

### 1c. SqllensDocumentParser today (`src/ftl/sqllens/document-parser.ts`)

Implements `DocumentParser.parse()` (`:79-189`) and `getDialectSymbols()` (`:62-77`). Does
**not** implement `decomposeQuery` or anything matching `traceLineageV2`, even though the
underlying logic exists as free functions:
- `decompose(compiledSql: string, dialect: Dialect): DecomposeResult` (`sqllens/decompose.ts:456`)
  — its own header says the seam call is `JSON.stringify(decompose(...))` (`decompose.ts:14-17`),
  i.e. it already documents the exact contract `debug-adapter.ts:2384-2387` expects
  (`JSON.parse(raw)` on whatever `ParseService.decomposeQuery` returns).
- `traceColumnLineage(sql: string, columnName: string, dialect: Dialect, schema?: SchemaMapping): LineageResult`
  (`sqllens/lineage.ts:100-121`) — same result shape as `FtlDocumentParser.traceLineageV2`'s
  `LineageResult` (`ftl-document-parser.ts:40-46` re-exports it), different parameter shape
  (explicit `dialect` + typed `SchemaMapping` vs. an internally-resolved dialect + JSON string).

`SqllensDocumentParser` has no `ready()`/`dispose()` — it is synchronous and pool-free by
construction (constructor just takes an `AdapterContext`, `document-parser.ts:48`) — so there is
nothing to boot or tear down.

`scripts/shadow-diff.ts` already constructs one `FtlDocumentParser` + one `SqllensDocumentParser`
per adapter and diffs `DocumentModel`s (`shadow-diff.ts:292-324`), with a reusable
canonicalize/diff pipeline (`:134-260`). It is a standalone CLI (`npx tsx scripts/shadow-diff.ts`),
never wired through `extension.ts` or `ParseService` — "a report, never a gate: exit code is
always 0" (`shadow-diff.ts:12`).

## 2. Setting design

### Name and shape

Recommend **`dbt-anvil.parser.engine`**, enum `"legacy" | "sqllens"`, default `"legacy"`.

The plan draft (`using-this-alias-humming-beacon.md:67`) names the eventual shadow setting
`dbtAnvil.ftl.shadowParser` — camelCase namespace, no existing `ftl` settings category. That
doesn't match this repo's actual convention: every setting in `package.json` is
`dbt-anvil.<category>.<name>` (dash-case namespace; categories are `providers`, `ninja`,
`database`, `queryEditor`, `terminal`, `notifications`, `lineage`, `layers` — grep of
`package.json` turns up zero `ftl`-namespaced settings and zero camelCase `dbtAnvil.*` keys).
`dbt-anvil.parser.engine` follows the established pattern and gives room for future
`dbt-anvil.parser.*` settings without a `ftl`/`sqllens` name baked into the key (the setting name
should outlive the migration; "legacy"/"sqllens" as VALUES are migration-scoped and fine to
rename again at Phase 3 cutover, but the KEY should not need renaming).

### What flips: construction-time, not per-parse

Route once, in `extension.ts`, at the point today's `FtlDocumentParser.create()` +
`ftlParser.ready()` block sits (`extension.ts:465-472`). Not per-parse-call: `ParseService`
holds one `_parser: DocumentParser` for its whole lifetime (`parse-service.ts:547`), and the
setting is not expected to change without a window reload (VS Code's normal contract for
settings that affect service construction — this extension does not currently offer any
runtime-hot-reloadable settings of this kind, so a "reload required" notice, matching the
existing `dbt-anvil.mcp.registration`-style settings that already require a restart per their
own description text, is the right precedent rather than inventing hot-swap machinery).

### Pyodide: warm only when selected, never both by default

```
const engine = vscode.workspace.getConfiguration('dbt-anvil').get<'legacy' | 'sqllens'>('parser.engine', 'legacy');

let documentParser: DocumentParser;
let ftlParser: FtlDocumentParser | undefined;

if (engine === 'sqllens') {
	documentParser = new SqllensDocumentParser(manifestIndexer);
	// no PyodideWorkerPool constructed — no boot, no 13M pyodide + 6.8M vendor sqlglot
	// loaded into a WASM worker, no ready() gate on activation.
} else {
	ftlParser = FtlDocumentParser.create(pyodideDir, vendorDir, scriptsDir, manifestIndexer, { logger });
	await ftlParser.ready();
	documentParser = ftlParser;
}
const parseService = new ParseService(documentParser, logger, { describeCache, indexer: manifestIndexer });
```

This is the main activation-time win of the wiring step: `engine: "sqllens"` means
`FtlDocumentParser.create`/`PyodideWorkerPool` are **never constructed**, so the worker spawn,
the 30s-per-worker timeout budget (`pyodide-worker-pool.ts:142-152`), and the WASM memory
footprint (up to 4 instances, `:132-134`) all disappear for that session. It does **not** shrink
the installed VSIX — `node_modules/pyodide` and `resources/ftl/vendor` still ship regardless of
the setting until Phase 3's actual deletion (see Risks).

### Fallback story if sqllens throws

No new fallback code is needed for the `ParseService`-mediated path: `getDocumentModel`'s
existing try/catch (`parse-service.ts:596-604`) already returns the stale cached model on any
parser exception, parser-agnostic. For the two call sites that bypass `ParseService`
(`get-column-lineage.ts:449-456` and `:480-484`), both already wrap their direct parser calls in
local try/catch returning `null`/`[]` — also parser-agnostic, no new code required there either.
The one thing that **does** need new code is widening those call sites' injected type from the
concrete `FtlDocumentParser` to a seam type that both engines satisfy (§3).

## 3. Method-by-method routing table

| Consumer / call site | Method | Legacy today | sqllens today | Gap to close |
|---|---|---|---|---|
| `ParseService._parse` (`parse-service.ts:920,926`) | `parse(sql, options)` | `ftl-document-parser.ts:116-149` | `document-parser.ts:79-189` — implemented | None. Drop-in via `DocumentParser`. |
| `ParseService.decomposeQuery` (`parse-service.ts:1009-1011`, optional-chained) | `decomposeQuery?(compiledSql)` | `ftl-document-parser.ts:97-102` (resolves dialect from `adapterType` via `mapAdapterToDialect`, delegates to pool) | **Not implemented on the class.** Free fn `decompose(compiledSql, dialect)` exists (`sqllens/decompose.ts:456`) | Add `decomposeQuery(compiledSql): Promise<string>` to `SqllensDocumentParser`: resolve `dialect = toSqllensDialect(this._context.adapterType)`, return `Promise.resolve(JSON.stringify(decompose(compiledSql, dialect)))` — matches the contract `decompose.ts:14-17` already documents and what `debug-adapter.ts:2384-2387` expects (`JSON.parse(raw)`). |
| `ParseService.getDialectSymbols` (`parse-service.ts:561-566`, optional-chained) | `getDialectSymbols?()` | `ftl-document-parser.ts:104-114` | `document-parser.ts:62-77` — implemented | None. |
| `GetColumnLineageTool` (`get-column-lineage.ts:451`) | `traceLineageV2(sql, columnName, schemaJson)` — **not on `DocumentParser`**, concrete `FtlDocumentParser` type required | `ftl-document-parser.ts:87-95` | **Not implemented.** Free fn `traceColumnLineage(sql, columnName, dialect, schema?)` exists (`sqllens/lineage.ts:100-121`), different signature (explicit `dialect` + typed `SchemaMapping` vs. internal dialect resolution + JSON string) | (a) Add `traceLineageV2(sql, columnName, schemaJson): Promise<LineageResult \| {error}>` to `SqllensDocumentParser`, parsing `schemaJson` and resolving dialect the same way `decomposeQuery` above does; (b) add `traceLineageV2?` to the `DocumentParser` interface (`document-parser.ts`) so `GetColumnLineageTool` can hold the seam type instead of `FtlDocumentParser` concretely — this is the one call site that forces a full retype, not just a routing branch. |
| `GetColumnLineageTool` (`get-column-lineage.ts:481`) | `parse(compiledCode, {schema})` — direct, bypasses `ParseService` | as row 1 | as row 1 — implemented | None for the method; only the container's declared type needs widening (same fix as the row above). |
| `extension.ts:469` | `ready()` — pool boot gate, **not on `DocumentParser`** | `ftl-document-parser.ts:75-77` | N/A — sqllens is sync | Conditional construction (§2) — only call when `engine !== 'sqllens'`. |
| `extension.ts:472` | `dispose()` — pool lifecycle | `ftl-document-parser.ts:79-81` | N/A | Only push `ftlParser` to `context.subscriptions` when it was actually constructed. |
| `EditorDiagnosticsProvider` / debug adapter (`debug-adapter.ts:2384`) | via `ParseService.decomposeQuery` → `DocumentParser.decomposeQuery?` | as row 2 | as row 2 | Covered by row 2's fix — no separate work. |

Net: two new instance methods on `SqllensDocumentParser` (`decomposeQuery`, `traceLineageV2`),
one interface widening (`DocumentParser.traceLineageV2?`), and one retype at the
`GetColumnLineageTool`/`registerLanguageModelTools` boundary from `FtlDocumentParser` to
`DocumentParser`. Everything else is the existing optional-method pattern already handling
"legacy implements it, a hypothetical other parser might not."

## 4. CallbackSchema opportunity

### What it is (`sql-dialect-grammars/src/qualify/schema-source.ts`)

`SchemaSource` is the interface `qualify`/`infer`/`lineage`/`symbols`/`completion` resolve
against (`schema-source.ts:30-39`): `columnsFor(parts, dialect)`, `tables(dialect)`, and a
monotonic `version` ("a bump means answers may have changed — drop memos keyed on me",
`:36-38`). `Schema` (the eager, upfront map `SqllensDocumentParser` uses today via
`new Schema(schema as SchemaMapping)`, `document-parser.ts:135`) is `version` constant 0.
`CallbackSchema` (`:56-156`) is the resolve-on-demand alternative: `columnsFor` calls a
host-supplied `TableResolver.resolve(parts)` **synchronously** every time (`:80-89`) — it does
NOT cache the answer itself, `revealed` is bookkeeping for `tables()` only. `undefined` records a
miss; `prime()` (`:110-118`, coalesced — concurrent calls return the same in-flight promise) is
the **one async seam**: it drains recorded misses through `TableResolver.fetch(missing)`,
re-probes, and bumps `version` only when something newly resolved (`drain()`, `:121-148`).

### What would change in ParseService

Today's enrichment (`parse-service.ts:889-905`) **eagerly awaits** `describeCache.columns()` for
every ref before calling `parser.parse()` — the same describe round-trips
`CallbackSchema.prime()` is built to do lazily. A `TableResolver` wrapping `DescribeCache` is
mechanical: `resolve(parts)` reads `indexer.getColumns(uniqueId)` (already synchronous,
`describe-cache.ts:101` reads the same cache `columns()` checks first at `:59-60`) and
`fetch(missing)` calls `describeCache.columns(uniqueId)` for each (the *same* work currently in
the `Promise.all` block, just moved off the parse's critical path). `SqllensDocumentParser`
would need a new `ParseOptions.schemaSource?: SchemaSource` field (the legacy sqlglot bridge has
no `SchemaSource` concept — it only understands the flat JSON `schema`/`schemaMapping`,
`parse-service.ts:907-910` — so this is sqllens-only, gated behind the routing setting) and pass
it to `qualify()`/the star-expander instead of building `new Schema(schema)`.

**Does versioned invalidation subsume `invalidateEnrichmentFor`/`evictUnenrichedDocuments`?**
Traced through the actual mechanics, not evenly:

- `evictUnenrichedDocuments()` (`parse-service.ts:801-814`) — the "manifest wasn't loaded when
  this parsed" case — **is subsumed**. This is exactly `CallbackSchema.prime()`'s design target:
  a miss because the answer wasn't available yet, later resolved, `version` bumps, a
  version-keyed memo (`SqlDocument`'s own `memoByVersion`, `document.ts:68-74`, is the reference
  implementation) re-derives automatically. No polling/watching needed.
- `invalidateEnrichmentFor(affectedIds)` (`:750-787`) — **not subsumed**. This handles a
  *different* case: a table's columns *changed* (e.g. a rebuilt model has a different schema)
  after already being resolved once. `CallbackSchema.columnsFor` re-calls `resolver.resolve()`
  live every time, so a resolver backed by a live `DescribeCache`/`ManifestIndexer` would in fact
  return the new columns on the next call — but `version` only bumps inside `drain()` when a
  **miss** resolves (`:146`), never when an already-known answer changes. `_version` is private
  with no public bump/invalidate hook (`schema-source.ts` exposes no mutation API beyond
  `prime()`). So a version-keyed memo would keep serving the *stale derived analysis*
  (DocumentModel, symbols, diagnostics) even though the raw resolver already has the fresh
  columns, until something else forces a recompute. `ParseService`'s own per-document cache
  eviction (today's `invalidateEnrichmentFor`) is that "something else" and stays needed exactly
  as it is today — it is evicting `ParseService`'s own memo, which is a layer CallbackSchema
  does not reach into.

**Re-publish-on-warm, mapped to what already exists**: sqllens's own LSP shows the pattern in
`src/lsp/features/diagnostics.ts` — pure translation from `doc.diagnostics` +
`doc.analyze(schema).diagnostics` to LSP diagnostics (`diagnostics.ts:13-41`), no re-parse; the
actual "call `prime()`, then re-publish" loop lives in that repo's server driver, not in this
file. This extension does not run an LSP at all — `ParseService` is VS Code's own provider-facing
analog, and it **already has** the identical pattern today: `onAliasesReady` fires after every
enriched parse (`parse-service.ts:961`) and `EditorDiagnosticsProvider` re-runs diagnostics off
it (`editor-diagnostics-provider.ts:172-176`). Adopting `CallbackSchema` would replace "fires
after every parse" with "fires when `prime()` resolves `true`" — structurally the same wiring,
just re-triggered off `SchemaSource.version` instead of off every parse call.

### Recommendation: follow-up, not part of this wiring step

Reasoning: (1) it only benefits the sqllens path — the sqlglot bridge has no `SchemaSource`
concept, so this is additive complexity scoped to one engine, better proven after sqllens is
live and stable behind the setting, not bundled into the higher-risk parser-swap change; (2) it
needs new `ParseService` plumbing independent of the swap goal — a shared `CallbackSchema`
instance, a new `ParseOptions` field, a new re-publish event; (3) the eviction/version-bump
nuance above is a real correctness edge (stale-schema-after-rebuild) that deserves its own
focused test coverage rather than landing inside the wiring step's diff.

## 5. StatementCell opportunity

### What it is (`sql-dialect-grammars/src/document/{document,split,shift}.ts`)

`SqlDocument` is a persistent, immutable per-open-file model: `create()` splits the text into
per-statement cells (`splitStatements`, `split.ts:126-135` — token-level, splits on channel-0
`;`/T-SQL `GO` at compound depth 0, BEGIN/CASE-aware), parses each cell independently, and caches
every tier; `withText()` produces a new instance for an edit while **carrying the content-
addressed `CellCache`** forward (`document.ts:110-133,329-331`) keyed by `dialect + " " +
cellText` (`:281`) — so a cell whose text is unchanged (even if it moved) is reused byte-for-byte
across edits, and only the touched cell's `qualify`/`deriveSymbols` re-runs (`cellAnalysis`,
`:434-441`, memoized per-`CachedCell` by schema identity+version). For a **single-statement**
document — `splitStatements` returns exactly one cell — the whole-document facade fields
(`ast`/`cst`/`scopes`) are literally the cell's own fields, "byte-exact with today"
(`document.ts:247-251`, restated at `:391-400`).

### Does it help this workload?

dbt model `.sql` files are, in the overwhelming case, a single top-level statement (one
`WITH ... SELECT` or plain `SELECT`) — there is no top-level `;` at depth 0 for `splitStatements`
to act on. That means `SqlDocument` would build exactly one cell for essentially every model
file in the editor, hitting its own documented single-cell fast path — i.e., **no incremental
reuse accrues in the primary workload**, because there is nothing to split. `ParseService`'s
existing cache (`_cache`/`_inflight`, `parse-service.ts:537-538`, hit on unchanged
`document.version`) already delivers the same "don't re-parse if nothing changed" result for the
single-statement case, with less machinery (no coordinate-shifting layer, no per-cell
`WeakMap` analysis memo).

Where multiple statements *could* appear — dbt pre-hook/post-hook blocks, `run-operation` macro
bodies — those are not, as far as this pass could confirm, fed through `ParseService`'s
per-document editor path today (hooks are Jinja strings inside YAML/config, not open `.sql`
documents with their own `TextDocument` identity); this was not exhaustively verified against
every `ParseService.parseContent`/`parseSqlString`/`parseRawForTokens` caller
(`parse-service.ts:971-1002`), so treat "does any current caller actually hand it multi-statement
compiled SQL" as an open question rather than a settled no.

### Recommendation: later, not a near-term follow-up

Adopting `SqlDocument` now would mean a new dependency and a new coordinate-shifting layer
(`shift.ts`) for zero measured benefit on the workload `ParseService` actually serves today.
Revisit only if a concrete multi-statement editing surface becomes a real feature (e.g. a
hook-editing view, or a `run-operation`/analysis SQL preview) — not in scope for the parser-swap
wiring step, and not worth carrying as a tracked TODO until such a feature is proposed.

## 6. Shadow-mode-in-prod option

A third setting value (`dbt-anvil.parser.engine = "shadow"`) running both engines on every live
parse and logging divergence, analogous to `scripts/shadow-diff.ts` but in-process.

**Value**: catches divergence on real user projects and real edit histories that the offline
harness's corpus (format fixtures + `samples/nba-monte-carlo` + `samples/jaffle_shop`,
`shadow-diff.ts:50-54`) doesn't cover — every Oatly model, every in-flight edit.

**Cost**: (1) requires booting Pyodide AND constructing sqllens simultaneously — no activation
win, the opposite of §2's main benefit; (2) doubles per-keystroke parse latency and memory
(WASM pool alive + sqllens IR built) on every parse, not just a batch run; (3) needs a live
diff-collection sink — `console.log` is not viable, and dumping full `DocumentModel` diffs
(potentially containing customer SQL text) needs a decision about where they land (a
`temp_auto`-style local-only file, or the existing `ILogger` at trace level) that the offline
harness never had to make (it writes to `temp_auto/shadow-diff-report.md` on a machine the
developer controls, not a live user session); (4) `shadow-diff.ts` explicitly frames itself as
"a report, never a gate" (`:12`) — there is no CI/test value in a live-shadow mode that the
offline, corpus-driven, `npm test`-adjacent harness doesn't already deliver more cheaply.

**Recommendation: not worth it now.** The plan's own Phase 2 gate (`using-this-alias-humming-
beacon.md:66-68`) is exactly "run the harness across the corpus, gate cutover on ~0 diffs per
dialect" — that's the offline harness's job, and it already exists and is runnable ahead of any
user opting into `engine: "sqllens"`. The two-value setting (`legacy`/`sqllens`) is enough to
ship this wiring step; `"shadow"` is a pure enum extension that can be added later with zero
redesign of the setting itself, if live-corpus divergence detection is ever wanted after cutover
begins. Nothing in this step should block on building it now.

## 7. Risks

1. **Activation-path branching, not just a flag.** Today `extension.ts` unconditionally
   constructs `FtlDocumentParser` and awaits `ready()` before `ParseService` exists
   (`extension.ts:465-472`). The routing branch (§2) means three downstream call sites that
   currently hold a concrete `FtlDocumentParser` — `registerLanguageModelTools`
   (`extension.ts:512`), `GetColumnLineageTool` (`extension.ts:527`) — must be retyped to the
   (widened) `DocumentParser` seam, not just have an `if` wrapped around their construction. This
   is the largest structural change in the step, not incidental to it.
2. **The 18MB bundle is not removed by this step.** `node_modules/pyodide` (13M) and
   `resources/ftl/vendor` (6.8M) ship in the VSIX regardless of `engine`'s value — the setting
   only controls whether they're **loaded at runtime**, not whether they're **packaged**. Actual
   size reduction is Phase 3 (delete Pyodide) work, not this step's. Don't oversell the win when
   describing this to anyone sizing the change.
3. **Test impact.** No activation-level test exists today (`src/test/` has no test exercising
   `extension.ts`'s `activate()` sequence) — this wiring step would be the first code to make the
   engine-selection branch itself testable, or else it ships covered only by the plan's existing
   manual F5 smoke checklist (`using-this-alias-humming-beacon.md`'s Verification section).
   `scripts/shadow-diff.ts` does not exercise this branch either — it constructs both parsers
   directly, bypassing `extension.ts`/`ParseService` entirely (`shadow-diff.ts:292-301`).
   Recommend at minimum a focused unit test around the construction branch (given engine=X,
   which concrete parser is built, and that `ftlParser.ready()` is/isn't called) rather than
   relying on manual smoke alone.
4. **`DocumentParser` interface growth is a one-way door for every future parser.** Adding
   `traceLineageV2?` (§3) to the shared interface means any future third `DocumentParser`
   implementation inherits the same optional-method surface area sqlglot's bridge shape
   accumulated. Small now; worth naming so it's a conscious choice, not a drift.

## 8. Staged task list

Each stage independently gated/committable; later stages assume earlier ones merged and green.

1. **`SqllensDocumentParser` parity methods.** Add `decomposeQuery()` (wrapping
   `sqllens/decompose.ts`'s `decompose()`, JSON-stringified per its own documented contract) and
   `traceLineageV2()` (wrapping `sqllens/lineage.ts`'s `traceColumnLineage()`, parsing the
   `schemaJson` string and resolving dialect via `toSqllensDialect`). Unit tests mirroring the
   existing `decompose.test.ts`/`lineage.test.ts` coverage, asserting the wrapper's JSON contract
   matches what `debug-adapter.ts`/`get-column-lineage.ts` expect byte-for-byte.
2. **Widen the seam.** Add `traceLineageV2?` to `DocumentParser` (`document-parser.ts`); retype
   `GetColumnLineageTool`'s constructor param and `registerLanguageModelTools`'s `ftlParser`
   param from `FtlDocumentParser` to `DocumentParser`. No behavior change — legacy still runs,
   `npm run typecheck` is the gate.
3. **The setting.** Add `dbt-anvil.parser.engine` to `package.json` (enum `legacy`/`sqllens`,
   default `legacy`, description noting a window reload is required). No consumption yet — dead
   config, safe to merge alone.
4. **Construction-time routing in `extension.ts`.** The branch in §2: conditional
   `FtlDocumentParser.create()`/`ready()`, unconditional (cheap) `SqllensDocumentParser`
   construction on the sqllens path, single `documentParser` passed to `new ParseService(...)`
   and to the two retyped call sites from stage 2. Gate: F5 smoke on both setting values —
   hover/definition/rename/diagnostics/format/lineage/debug-adapter — per the plan's own
   Verification section, on both a databricks project and `samples/nba-monte-carlo` (duckdb).
5. **Widen the offline corpus.** Extend `scripts/shadow-diff.ts`'s `DEFAULT_ROOTS`
   (`shadow-diff.ts:50-54`) with more of the Oatly project tree (or point `--dir` at it in CI/dev
   routine) so the ~0-diff gate is measured against a realistic model count before recommending
   `engine: "sqllens"` as anyone's default. This stage doesn't touch product code — pure harness
   corpus growth — and can run in parallel with stages 1-4.
6. **(Follow-up, separate from this task list) CallbackSchema wiring** — per §4's
   recommendation, only after stage 4 is live and stable.
