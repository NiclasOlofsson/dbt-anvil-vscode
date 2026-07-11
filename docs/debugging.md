# Debugging SQL: Architecture and Implementation

This document explains how the dbt Anvil SQL debugger works: conceptually, architecturally, and in implementation detail. It covers `debug-adapter.ts`, `debug-symbols.ts`, `debug-pipeline-provider.ts`, the native SQL parser (sqllens), the Python bridge (dbt compilation), and their collective integration with the VS Code Debug Adapter Protocol.

---

## Part I: The Concept — What Does It Mean to Debug SQL?

### Why SQL Has Never Had a Real Debugger

Debuggers are one of the oldest tools in programming. Since the 1960s, every serious language runtime has provided a way to pause execution, inspect state, and step through code. C has GDB. Java has JDWP. .NET has the managed debugger backed by PDB symbols. JavaScript has Chrome DevTools. Even shell scripts have `set -x`.

SQL has had… nothing.

This isn't an accident. SQL is a *declarative* language. You describe *what* you want, not *how* to get it. The database optimizer decides the execution plan: which tables to scan, which joins to use, what order to evaluate predicates. There's no instruction pointer because there are no instructions. There's no call stack because there are no function calls. The query planner is a black box that takes your intent and produces a result.

This is fundamentally different from imperative languages where a debugger maps 1:1 onto the execution model. In C#, the debugger pauses at an IL offset that corresponds to a source line. In SQL, there's no IL. There's no offset. The optimizer may execute your query in an order completely unrelated to how you wrote it.

So the industry gave up. SSMS (SQL Server Management Studio) tried. It shipped a T-SQL debugger that could step through stored procedures. It was removed in SSMS 18 (2018) because it was unreliable, slow, and fundamentally limited by the fact that it tried to debug the *imperative wrapper* (T-SQL control flow) rather than the *data flow*. Oracle SQL Developer had a PL/SQL debugger with similar limitations. MySQL Workbench never shipped one at all.

The dbt ecosystem made the problem worse. dbt adds a Jinja templating layer on top of SQL, creating a two-language compilation pipeline: Jinja compiles to SQL, which the database then executes. When something goes wrong, the developer is staring at Jinja source that compiles to SQL that the optimizer rearranges into an execution plan three abstraction layers deep. The debugging experience is `dbt run`, wait 20 seconds, read a wall of text in the terminal, and try again.

### The Insight: CTEs as Functions, Clauses as Instructions

The breakthrough is recognizing that modern SQL (specifically CTE-heavy analytical SQL as written in dbt) *does* have structure that maps onto debugger concepts. Not perfectly, not 1:1, but close enough to build a real tool.

Consider a C# program:

```csharp
var filtered = GetOrders().Where(o => o.Amount > 100);
var grouped = filtered.GroupBy(o => o.Region);
var result = grouped.Select(g => new { g.Key, Total = g.Sum(o => o.Amount) });
```

This is a data transformation pipeline. Each method call takes input, transforms it, and passes the result forward. A debugger lets you pause after each call, inspect the intermediate data, and step forward or backward.

Now the same logic in dbt SQL:

```sql
with filtered as (
    select * from {{ ref('orders') }}
    where amount > 100
),
grouped as (
    select region, sum(amount) as total
    from filtered
    group by region
)
select * from grouped
```

**CTEs are functions.** Each CTE takes input (from referenced CTEs or tables), transforms it, and produces a named intermediate result. The final `SELECT` is `main()`. The CTE dependency chain is a call stack: `grouped` depends on `filtered`, which depends on `orders`.

**Clauses are instructions.** Within a single CTE, SQL has a well-defined logical execution order: `FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT`. This is the *data flow* order (not the textual order; `SELECT` appears first in the source but executes last). Each clause is an instruction that transforms the working set.

This gives us a two-level stepping model:

1. **Statement-level** (Step Over) — advance to the next CTE. Like stepping over function calls.
2. **Clause-level** (Step Into) — step through `FROM → WHERE → GROUP → SELECT` within a single CTE. Like stepping through instructions inside a function.

And because each CTE can be executed independently (the database evaluates it and returns a result set), we can actually *run* each step and show the intermediate data. This is something a traditional debugger can't easily do. You can't execute half a C# method and see its partial result. But SQL CTEs are self-contained queries. We execute `filtered`, show the rows, then execute `grouped` (which references the already-cached `filtered` result), show those rows, and so on.

### The Compilation Model

The analogy extends to the full compilation pipeline:

| Concept | .NET / Java | dbt Debugger |
|---------|-------------|--------------|
| High-level source | C# / Java | dbt SQL + Jinja |
| Compiled output | IL / bytecode | Expanded SQL with `@dbg` markers |
| Debug symbols | PDB / DWARF | `/* @dbg:L:C:role */` comment markers |
| Source map | PDB line tables | `SourceMap` from `parseSourceMap()` |
| Execution unit | Method / function | CTE or final SELECT |
| Instruction pointer | IL offset | Current clause within current frame |
| Call stack | Method call chain | CTE dependency DAG |
| Inlined method | JIT-inlined code | Macro expansion (opaque span) |
| External assembly | .dll without PDB | `ref()` / `source()` to other models |

When you press F5 in VS Code on a `.cs` file, the C# compiler produces IL (intermediate language) plus a PDB (program database) file containing line-number mappings. The .NET runtime loads both, and the debugger uses the PDB to map IL offsets back to source lines.

We do the same thing. dbt's Jinja templating engine is our compiler: it turns `{{ ref('orders') }}` into `"analytics"."public"."orders"`. We inject debug symbol markers (`/* @dbg:L5:C12:column */`) into the compiled SQL, creating our "PDB". When the database executes a CTE and we need to highlight the corresponding source line, we look up the compiled line in our source map and jump to the original Jinja-SQL position.

---

## Part II: The Debug Adapter Protocol (DAP)

### What Is DAP?

The [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) is a JSON-based wire protocol that standardizes how editors talk to debuggers. Microsoft created it for VS Code, but it's now used by Neovim, Eclipse, Emacs (via dap-mode), and others.

The key insight of DAP is separation of concerns: the editor knows how to render a debug UI (call stack, variables, breakpoint gutters, stepping buttons), and the debug adapter knows how to control a runtime. They communicate through a standard set of request/response messages. The editor never needs to know that it's debugging Python vs. C++ vs. SQL. It just sends `next`, `stepIn`, `stackTrace`, `variables` and renders whatever comes back.

This is exactly why DAP works for SQL debugging even though SQL isn't an imperative language. The protocol doesn't assume an imperative execution model. It provides abstract operations (frames, scopes, variables, stepping) that we map onto our CTE/clause model. VS Code's debug UI renders them identically to a C# debug session.

### How DAP Connects to VS Code and Our Extension

```
┌──────────────────────────┐
│    VS Code Debug UI      │
│  (call stack, variables, │
│   breakpoints, toolbar)  │
└────────┬─────────────────┘
         │  DAP messages (JSON)
         ▼
┌──────────────────────────┐
│   SqlDebugAdapter        │
│   (debug-adapter.ts)     │
│                          │
│  ┌───────────────────┐   │
│  │ Debug Symbols     │   │  in-process (sqllens parser)
│  │ (debug-symbols.ts)│   │
│  └───────────────────┘   │
│  ┌───────────────────┐   │     stdin/stdout JSON
│  │ Compile Cache     │   │◄──────────────────────┐
│  │ (compile-cache.ts)│   │               ┌───────┴──────┐
│  └───────────────────┘   │               │  bridge.py   │
│  ┌───────────────────┐   │               │  (Python)    │
│  │ Database Provider │   │               │  • dbt core  │
│  │ (runs queries)    │   │               └──────────────┘
│  └───────────────────┘   │
└──────────────────────────┘
```

The registration chain:

1. **`package.json`** declares a debugger type `dbt-sql` with launch configurations, breakpoint support for `jinja-sql` files, and configuration attributes (`file`, `limit`, `scope`, `resultLocation`).
2. **`extension.ts`** registers a `DebugAdapterDescriptorFactory` that creates a fresh `SqlDebugAdapter` instance per F5 launch, plus a `DebugConfigurationProvider` for default configs.
3. Each F5 press creates a new adapter instance injected with the extension's shared services (query runner, bridge runner, compile cache, database provider, manifest indexer).
4. VS Code sends DAP messages to the adapter's `handleMessage()`. The adapter responds via `_send()` and `_sendEvent()`.
5. The adapter and the Data Pipeline TreeView are in separate contexts. They communicate via custom DAP events (`pipeline` event), received by the extension host through `onDidReceiveDebugSessionCustomEvent`.

### DAP Capabilities We Declare

In the `initialize` response, the adapter declares what it supports:

| Capability | Value | Meaning |
|-----------|-------|---------|
| `supportsStepBack` | `true` | Step Back button enabled: replays cached CTE results |
| `supportsRestartFrame` | `true` | Right-click → "Restart Frame" in call stack |
| `supportsFunctionBreakpoints` | `true` | Break by CTE name |
| `supportsBreakpointLocationsRequest` | `true` | Editor can query which lines are breakable |
| `supportsStepInTargetsRequest` | `true` | Step Into dropdown lists CTEs and ref() targets |

---

## Part III: The Implementation

### 3.1 The Two Runtimes — Native Parsing, Python for dbt Itself

The debugger spans two runtimes, each doing the only job it has to:

- **SQL understanding is native TypeScript.** Symbol emission, source mapping, and query decomposition all run in-process on the extension's SQL parser (sqllens, see `src/ftl/sqllens/`). No subprocess, no round-trip, synchronous parses.
- **Jinja compilation is dbt's job, and dbt runs in Python.** `bridge-runner.ts` spawns `bridge.py` at first use and keeps it alive for the VS Code session. Commands are serialized through a queue: one request at a time, FIFO order. The bridge loads dbt's manifest once and caches it, so repeated compiles are fast (~50-200ms).

The debugger uses exactly one bridge command:

**`compile_inline`**: Runs `dbt compile --inline <sql>` to resolve Jinja templates without executing. The debugger sends the *marker-annotated* source through this (see 3.2). The `@dbg` comment markers are plain SQL comments, so they survive dbt compilation intact and come out attached to the compiled SQL.

Frame extraction is native. `SqllensDocumentParser.decomposeQuery()` (`src/ftl/sqllens/decompose.ts`) takes the compiled SQL and returns:

- `frames[]`: Each CTE and the final SELECT, with name, type, and line range
- `clauses{}`: Per-frame breakdown into FROM, JOIN, WHERE, GROUP BY, HAVING, SELECT, each with SQL text, source line, and execution order
- `refs{}`: Per-frame list of referenced CTEs (for the dependency DAG)

Before extraction runs, a subquery-promotion pass lifts any inline subquery in a `FROM` or `JOIN` clause out into a synthetic named CTE (named after the subquery's alias, or `__subq_N__` if none), and `UNION` legs are promoted the same way. This means the rest of the pipeline always sees a flat list of named CTEs: no special-casing for inline subqueries anywhere downstream. Clause SQL is produced by *slicing the source text at CST spans*. The parser never regenerates SQL, so what you step through is byte-for-byte what the database sees. The `order` field on each clause reflects SQL's logical execution order (FROM=0, JOIN=1, WHERE=2, etc.), which is the order the debugger steps through.

### 3.2 Debug Symbols and Source Maps (`debug-symbols.ts`)

#### Marker Injection

`emitDebugSymbols()` is pure TypeScript. sqllens parses the (jinja-blanked) source directly and `deriveSymbols` yields its semantic `Sym` model: every identifier, keyword, and literal with its frame attribution (`Sym.frame`: which CTE body owns it, `MAIN_FRAME` for the final select). Jinja tags are classified off the same parse's tag AST: `ref()`, `source()`, or generic macro. From that, `injectMarkers()` annotates the *raw source* with four marker types:

- `/* @dbg:L{line}:C{col}:{role} */` around each SQL token
- `/* @macro:start name="..." source_line=N */` … `/* @macro:end */` around macro expansions
- `/* @ref:name="..." source_line=N */` … `/* /@ref */` around `ref()` expansions
- `/* @source:schema="..." name="..." source_line=N */` … `/* /@source */` around `source()` expansions

The annotated source then goes through `compile_inline`: dbt expands the Jinja, the comment markers ride along unchanged, and the compiled output arrives already annotated. There is no separate "inject into compiled SQL" step.

#### The Four-Marker System

Every character in compiled SQL is covered by exactly one marker type:

| Marker | Covers | Purpose |
|--------|--------|---------|
| `@dbg:L:C:role:cteName` | SQL tokens written by the user | Per-token bidirectional source mapping |
| `@macro:start/end` | Expanded macro content | Opaque boundary: maps entire expansion to the Jinja call site |
| `@ref:name` | Expanded `ref()` calls | Cross-model navigation edge |
| `@source:schema:name` | Expanded `source()` calls | External data boundary |

The CTE name on `@dbg` markers is what enables `restartFrame` to do targeted cache invalidation. When a CTE is edited mid-debug, the adapter knows which cache entries belong to that CTE by name, and can evict only those (plus downstream dependents).

#### Source Map Structure

`parseSourceMap()` extracts markers via regex and builds an indexed `SourceMap` object:

```typescript
interface SourceMap {
    mappings: SourceMapping[];         // All @dbg markers as structured entries
    macroSpans: MacroSpan[];           // @macro boundaries
    refMarkers: RefMarker[];           // @ref positions
    sourceMarkers: SourceMarker[];     // @source positions
    sourceToCompiled(line): SourceMapping[];    // Source line → compiled positions
    compiledToSource(line): SourceMapping[];    // Compiled line → source positions
    compiledLineToSourceLine(line): number | undefined;  // Quick lookup
    isInsideMacro(line): MacroSpan | undefined;
}
```

The lookup indexes (`bySourceLine`, `byCompiledLine`) are built at parse time for O(1) bidirectional mapping. `compiledLineToSourceLine()` returns the source line for a compiled line, or `undefined` if no marker covers that line. There is no interpolation fallback: every line the debugger cares about must have explicit marker coverage.

### 3.3 The Debug Adapter (`debug-adapter.ts`)

The adapter is a ~1500-line class that implements `vscode.DebugAdapter`. A fresh instance is created for each F5 launch. It manages all debug state: frames, clauses, current position, result cache, breakpoints, and source map.

#### Launch Sequence

When the user presses F5:

1. **`initialize`** — Adapter declares DAP capabilities
2. **`launch`** — The main setup:
   - Detect the SQL statement under cursor (or all statements if `scope: 'all'`)
   - Call `emitDebugSymbols()` (native, sqllens) to inject `@dbg` markers into the raw source
   - Call bridge `compile_inline` on the annotated source: dbt resolves Jinja, markers ride through
   - Call `decomposeQuery()` (native, sqllens) to extract frames, clauses, and refs
   - Apply line offsets (if cursor selected a statement mid-file)
   - Remap frame/clause positions from compiled space to source space via `_remapPositions()`
   - If `noDebug: true`: execute the full query and terminate
   - If `noDebug: false`: pause at entry and wait for stepping commands
3. **`configurationDone`** — Start execution: run to first breakpoint, or stop at the last frame (`_main_`)

#### Frame and Clause Model

```
Statement-level view (Step Over):          Clause-level view (Step Into):
┌──────────────────────┐                   ┌──────────────────────────────┐
│ _main_         ← top │                   │ cte_home_losses → select     │
│ cte_away_wins        │                   │ cte_home_losses → where      │
│ cte_home_wins        │                   │ cte_home_losses → from  ← IP │
│ cte_home_losses ← IP │                   └──────────────────────────────┘
│ cte_wins             │
│ cte_losses           │
└──────────────────────┘
```

**Statement granularity**: Frames are CTEs ordered by dependency (last = `_main_`). The call stack shows the current frame at top, with already-executed frames below in reverse execution order. Future frames (not yet executed) are *not* shown, just like a C# debugger doesn't show functions that haven't been called yet.

**Clause granularity**: When the user steps into a frame (F11), the adapter switches to line-level granularity. The call stack now shows clauses within that CTE in execution order (FROM → JOIN → WHERE → GROUP → HAVING → SELECT). Only already-executed clauses appear. The user sees WHERE after stepping past FROM, not before.

#### Stepping Logic

| DAP Request | Statement Granularity | Clause Granularity |
|-------------|----------------------|-------------------|
| `next` (F10) | Advance to next frame | Advance to next clause |
| `stepIn` (F11) | Enter clause-level for current frame | Step into targeted CTE or ref model |
| `stepOut` (Shift+F11) | — (already at top level) | Return to statement-level |
| `stepBack` | Move to previous frame (cached, free) | Move to previous clause (cached, free) |
| `continue` (F5) | Run to next breakpoint | Run to next breakpoint |

Step Back is free because every executed step's result is cached in `_resultCache`. The adapter pops one entry from `_navigationHistory` and restores that position, replaying the cached `StepResult`. No re-execution occurs. This is effectively reverse debugging without the overhead, possible because SQL CTEs are pure functions with no side effects.

#### Execution and Caching

Each step executes SQL against the database via the `DatabaseProvider`:

- **Frame execution**: Builds a query from all CTEs up to and including the current frame, wraps it in a `__debug_count__` window function for row counts, and runs it with a `LIMIT`.
- **Clause execution**: Builds a query scoped to the current clause within the current CTE (e.g., just the `FROM` + `WHERE` portion), similarly wrapped.
- **Cache keys**: `frameName:frame` for statement-level, `frameName:clause:index` for clause-level.

Results are cached in a `Map<string, StepResult>`. Step Back reads from cache. `restartFrame` selectively evicts entries.

#### Source Map Remapping (`_remapPositions`)

After `decompose_query` returns frame and clause positions in *compiled* line numbers, `_remapPositions()` translates them to *source* line numbers using the `SourceMap`. This is critical because the user sees the original Jinja-SQL source, not the compiled output.

The remapping also enforces a non-overlapping constraint: frames shouldn't overlap in source space (even though CTE definitions are textually nested in the `WITH` clause). It sorts frames by source position and clips any overlapping ranges. Every frame used in remapping must have marker coverage: a frame with no `@dbg` markers in its compiled range stays in compiled-line space and would corrupt adjacent source-space frames via the ordering clip.

#### Breakpoints

**Line-based breakpoints** (`setBreakpoints`): The user clicks the gutter. The adapter maps the source line to a frame via `_frames` line ranges. If the line falls within a frame's source range, the breakpoint is verified and associated with that frame.

**Function breakpoints** (`setFunctionBreakpoints`): The user types a CTE name. The adapter checks if that name exists in `_frames`. Verification is by exact name match.

**Breakpoint resolution at continue time**: When `continue` runs, it needs to find the *next* breakpoint in execution order. For line breakpoints inside a frame with clause-level resolution, it calls `_resolveClauseIndex()` to map the breakpoint line to a specific clause. Among all breakpoints ahead of the current position, the adapter picks the one with the earliest *execution order* (FROM before WHERE before SELECT), not the earliest *source line*. This is essential because SQL execution order differs from textual order.

#### restartFrame (Edit and Continue)

When the user edits a CTE mid-debug and right-clicks → "Restart Frame", the adapter:

1. **Recompiles** the model with debug symbols (the source has changed)
2. **Re-decomposes** the compiled SQL into frames/clauses
3. **Compares CTE structure**: If CTE names or count changed, the entire result cache is invalidated (the pipeline shape changed). If structure is preserved, only the target frame and its downstream dependents are evicted from cache.
4. **Re-executes** from the restarted frame index forward

This is the dbt equivalent of .NET's Edit and Continue: modify code, the runtime recompiles just that method, and execution resumes from the edited point. Upstream CTEs that haven't changed keep their cached results; they don't re-execute.

#### Cross-Model Stepping

`stepInTargets` returns two kinds of targets:

1. **Local CTEs**: Other CTEs in the current model that the current frame references
2. **External refs**: `ref()` targets identified by `@ref` markers in the compiled SQL

When the user selects an external ref, `_tryCrossModelStepIn()` resolves the model path via the manifest indexer, and launches a nested `vscode.debug.startDebugging()` session for that model. This is analogous to stepping into another `.dll` in .NET: the debugger opens the referenced model's source, compiles it, and starts a new debug session.

#### REPL Evaluate

The debug console supports expression evaluation. When the user types a SQL expression (e.g., `select count(*) from cte_home_losses`), the adapter wraps it in a CTE context using `buildScopedSql()`:

```sql
WITH __debug_context__ AS (
    <clauses from current frame>
)
SELECT <user expression> FROM __debug_context__
```

If the expression is already a full `SELECT` or `WITH` query, it's executed as-is.

### 3.4 Three Scopes: Result, Impact, Query

Each paused frame exposes three variable scopes in the VS Code Variables panel:

| Scope | Contents | Analogy |
|-------|----------|---------|
| **Result** | Column names and first-row values from the frame's execution | Local variables: the data this CTE produced |
| **Impact** | Total row count, execution time, fan-out detection (row count increased vs. input) | Performance counters: is this CTE exploding the data? |
| **Query** | Frame name, type (CTE/select), SQL text, clause breakdown | Disassembly view: the actual SQL being executed |

Scope and variable references are packed into a single integer using bit encoding: `((frameIndex & 0xFFFF) << 16) | ((scope & 0xFF) << 8) | (extra & 0xFF)`. This avoids maintaining a reference-to-scope lookup map.

### 3.5 Data Pipeline TreeView

A `TreeDataProvider` in the Run and Debug sidebar that visualizes the CTE dependency DAG during active debug sessions.

#### Architecture

The adapter and TreeView live in separate VS Code contexts. The adapter is a fresh instance per F5; the TreeView persists in the extension host. They communicate via custom DAP events:

1. Adapter calls `_sendPipelineEvent()` with the current frame state after each `_sendStopped()`
2. Extension host receives the event via `onDidReceiveDebugSessionCustomEvent`
3. `DataPipelineProvider.handlePipelineEvent()` updates state and fires `_onDidChangeTreeData`
4. On session terminate, `onDidTerminateDebugSession` → `provider.clear()`

No shared mutable state. The event body carries everything the TreeView needs:

```typescript
interface PipelineEventBody {
    frames: DecomposeFrame[];
    refs: Record<string, string[]>;
    currentFrameIndex: number;
    executedFrames: Record<string, { rows: number; executionMs: number }>;
    // Clause-level step progress for the current frame (only in line granularity)
    clauseSteps?: PipelineClauseStep[];
}
```

#### Two Modes

- **Full DAG** — Tree rooted at `_main_`, expanding shows all dependencies. Every frame visible.
- **Current Stack** — Only frames on any path from a root to the current frame. Like filtering the Call Stack to the active dependency chain.

Toggle via toolbar button on the view title.

#### Visibility and Navigation History

The TreeView's "executed" state is driven by `_navigationHistory` in the adapter, not by whether a frame has a cache entry. Only frames the user has actually navigated *to* appear as executed: frames silently evaluated as prerequisites (e.g. when hitting a breakpoint mid-pipeline) remain pending until explicitly visited. This prevents the tree from showing frames as green that the user has never seen.

#### Node Appearance

| State | Icon | Description |
|-------|------|-------------|
| Current frame / clause | custom orange arrow | Currently stopped here |
| Executed | `$(circle-filled)` (green) | Row count shown |
| Pending | `$(circle-outline)` | Not yet executed |
| Fan-out detected | `$(warning)` (yellow) | Clause produced more rows than the previous clause, likely a bad join |
| External ref | `$(database)` | Leaf node: external table or model |

### 3.6 Three-Tier Frame Taxonomy

Every piece of SQL the debugger encounters falls into one of three tiers:

| Tier | Debugger Concept | .NET Equivalent | Symbol Coverage | Stepping |
|------|-----------------|-----------------|----------------|----------|
| User code | CTEs in current model | Your methods | Full `@dbg` markers | Step in/over/out, clause-level |
| External module | Macro expansions | BCL / NuGet (no PDB) | `@macro:start/end` span | Step over only |
| External assembly | `ref()` / `source()` | Another .dll | Separate debug session or leaf | Cross-model step in |

This follows "Just My Code" semantics: the debugger skips macro content during stepping, exactly like VS Code's `presentationHint: 'deemphasize'` for library frames. Macro expansions are opaque: you see where the macro was called and what it expanded to, but you can't step through the expansion's internal logic.

---

## Part IV: Future Directions

### View Inlining / EXPLAIN-Driven DAG Enrichment

When a model references a database view (not a table), the database inlines the view definition into the query plan. A model that references 3 views might actually execute a query touching 30 tables through nested view expansion. This is invisible at the dbt source level and is frequently the root cause of performance problems.

**Analogy**: JIT method inlining. The source shows one function call; the JIT inlines it into a deep chain. A source-level profiler misses the real cost.

**Direction**: After `decompose_query` builds the compile-time DAG, optionally expand ref/source nodes by fetching view definitions from the database. For each ref that resolves to a view, recurse, adding "ghost nodes" to the TreeView:

- **Solid nodes**: CTEs (your code, full debug symbols)
- **Dashed/dimmed nodes**: Inlined view layers (database code, no symbols)
- **Terminal nodes**: Actual tables (data boundary)

---

## File Map

| File | Role |
|------|------|
| `src/dbt/debug-adapter.ts` | DAP adapter: handles all protocol requests, manages frames/clauses/stepping/caching |
| `src/dbt/debug-symbols.ts` | Symbol emission (`emitDebugSymbols`, sqllens `Sym`-backed), marker injection, and source map parsing (`parseSourceMap`) |
| `src/ftl/sqllens/decompose.ts` | Native frame extraction: compiled SQL → frames/clauses/refs by CST-span slicing, with subquery/UNION promotion |
| `src/dbt/debug-pipeline-provider.ts` | TreeView provider for the Data Pipeline view in the Debug sidebar |
| `src/dbt/debug-config-provider.ts` | Debug configuration provider (launch config resolution) |
| `src/dbt/compile-cache.ts` | Shared in-memory cache for compiled SQL, with mtime/hash validation |
| `src/dbt/bridge-runner.ts` | Persistent Python child process manager: spawns `bridge.py`, serializes commands |
| `resources/bridge/bridge.py` | Python bridge: `compile_inline` (dbt Jinja resolution) and the other dbt-side commands |
