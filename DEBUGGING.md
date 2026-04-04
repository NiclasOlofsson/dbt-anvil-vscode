# Debugger Architecture

This document describes the architecture of the dbt SQL debugger — both what exists today and where it's headed. It's the reference for contributors working on `debug-adapter.ts`, `debug-symbols.ts`, `debug-pipeline-provider.ts`, and the bridge's `decompose_query` / `emit_debug_symbols` commands.

## The Assembler Analogy

The debugger uses the same architecture as traditional language debuggers, just applied to SQL:

- **dbt SQL + Jinja** is the high-level source language (like C# or Java).
- **Compiled SQL with `@dbg` markers** is the assembler output (like IL/bytecode). The Jinja templating engine compiles the source, and we inject debug symbols into the result.
- **The database** is the runtime (like the CLR/JVM). It executes the compiled SQL; the debugger interprets the results.
- **The source map** bridges source ↔ compiled positions, exactly like a PDB file or JavaScript `.map`.

| Concept | .NET / Java | dbt Debugger |
|---------|-------------|--------------|
| High-level source | C# / Java | dbt SQL + Jinja |
| Compiled output | IL / bytecode | Expanded SQL with `@dbg` markers |
| Debug symbols | PDB / DWARF | `/* @dbg:L:C:role */` comment markers |
| Source map | PDB line tables | `SourceMap` from `parseSourceMap()` |
| Execution unit | Method / function | CTE or final SELECT |
| Instruction pointer | IL offset | Current clause within current frame |
| Call stack | Method call chain | CTE dependency DAG |
| Inlined method | JIT-inlined code | Macro expansion (opaque) |
| External assembly | .dll with no PDB | `ref()` / `source()` to other models |

## DAP Concepts as Implemented

The debugger implements the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) via `DebugAdapterInlineImplementation` — a fresh adapter instance is created for each F5 launch.

### Frames

Frames are CTEs plus the final SELECT. They aren't a traditional call stack (there's no call/return) but a data dependency chain. The adapter supports two granularity levels:

- **Statement** (frame-level) — like stepping over functions. Each step advances to the next CTE.
- **Line** (clause-level) — like stepping through instructions within a function. Each step advances through FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT within a single CTE.

### Clause Execution Order

SQL's logical execution order is FROM → JOIN → WHERE → GROUP BY → HAVING → SELECT. This is the *data flow* order, not the textual order (SELECT appears first in source but executes last). The debugger steps in execution order, just like a debugger steps through IL instruction order rather than source order.

### Breakpoints

Two kinds are supported:

- **Line-based** — mapped via the source map to frames. Resolution accounts for the source-vs-execution order mismatch: when continuing to a breakpoint, the adapter finds the earliest *execution-order* match, not the earliest *source-order* match.
- **Function-based** — by CTE name (the CTE name acts as the function name).

### Scopes

Three domain-specific scopes per frame:

| Scope | Purpose | .NET Equivalent |
|-------|---------|-----------------|
| Result | Column values from executing the frame | Local variables |
| Impact | Row counts, deltas, fan-out metrics | Profiler counters |
| Query | SQL text, clause breakdown, execution metadata | Disassembly view |

### Stepping

| DAP Request | Behavior | Analogy |
|-------------|----------|---------|
| Next | Advance clause (line granularity) or frame (statement granularity) | Step Over |
| Step In | Enter clause-level granularity, or jump to referenced CTE/model | Step Into |
| Step Out | Exit clause-level back to statement granularity | Step Out |
| Step Back | Replay cached result — free, no re-execution | Reverse debugging |
| Continue | Run to next breakpoint | Continue |

### Cross-Model Stepping

`_tryCrossModelStepIn` opens a nested debug session for a `ref()`-referenced model. This is analogous to stepping into another .dll in .NET — the debugger resolves the model path, compiles it, and launches a child debug session.

## Symbol Format

### Current Markers

Each SQL token gets wrapped with position markers:

```sql
/* @dbg:L5:C12:column */ customer_id /* /@dbg */
```

Format: `/* @dbg:L{line}:C{col}:{role} */ TOKEN /* /@dbg */`

The `role` encodes what the token represents (column, keyword, literal, etc.). `parseSourceMap()` in `debug-symbols.ts` extracts these markers into a `SourceMap` with bidirectional lookup indexes.

### Planned: Four-Marker System

The goal is complete symbol coverage — every character in compiled SQL mapped by exactly one marker type:

| Marker | Covers | Purpose |
|--------|--------|---------|
| `@dbg:L:C:role:cteName` | User SQL tokens | Per-token source mapping with stable CTE identity |
| `@macro:start/end` | Macro expansions | Opaque boundary — maps entire expansion to call site |
| `@ref:name` | `ref()` expansions | Cross-model edge with call site coordinates |
| `@source:schema:name` | `source()` expansions | External data boundary with call site coordinates |

Adding the CTE name to `@dbg` markers enables **hot-reload** (Edit and Continue): when a CTE is edited mid-debug, only its cache entry is invalidated by name. The `restartFrame` DAP request can then re-execute from that frame forward.

Once all four marker types are implemented, interpolation fallbacks in `_remapPositions` become dead code — every compiled line will be deterministically mapped.

## Data Pipeline TreeView

A TreeView in the Run and Debug sidebar that visualizes the CTE dependency DAG during debug sessions. Defined in `debug-pipeline-provider.ts`.

### Wiring

The adapter and TreeView live in separate contexts (adapter is a fresh instance per F5; TreeView is in the extension host). They communicate via custom DAP events:

1. Adapter calls `_sendPipelineEvent()` after each `_sendStopped()`.
2. Extension host receives event via `onDidReceiveDebugSessionCustomEvent`.
3. `DataPipelineProvider.handlePipelineEvent()` updates state and fires `_onDidChangeTreeData`.
4. On session terminate, `onDidTerminateDebugSession` → `provider.clear()`.

No shared mutable state between adapter and TreeView.

### Two Modes

- **Full DAG** — tree rooted at `_main_`, expanding shows dependencies. All frames visible.
- **Current Stack** — only frames on any path from a root to the current frame. Like the Call Stack filtered to the active dependency chain.

Toggle via toolbar button on the view title (switches between `$(list-tree)` and `$(git-merge)` icons).

### Node Appearance

| State | Icon | Description |
|-------|------|-------------|
| Current frame | `$(debug-stackframe)` | Currently stopped here |
| Executed | `$(check)` (green) | Row count shown |
| Pending | `$(circle-outline)` | "pending" |
| Fan-out detected | `$(warning)` (yellow) | Row count increased vs. dependency |
| External ref | `$(database)` | Leaf node — external table or model |

## Three-Tier Frame Taxonomy

Every piece of SQL the debugger encounters falls into one of three tiers:

| Tier | Debugger Concept | .NET Equivalent | Symbol Coverage | Stepping |
|------|-----------------|-----------------|----------------|----------|
| User code | CTEs in current model | Your C# methods | Full `@dbg` markers | Step in/over/out, clause-level |
| External module | Macro expansions | BCL / NuGet (no PDB) | `@macro:start/end` span | Step over only |
| External assembly | `ref()` / `source()` | Another .dll | Separate debug session or leaf | `_tryCrossModelStepIn` |

This follows "Just My Code" semantics: the debugger skips macro content during stepping, exactly like VS Code's `presentationHint: 'deemphasize'` for library frames.

## Future: View Inlining / EXPLAIN-Driven DAG Enrichment

When a model references a database view (not a table), the database inlines the view definition into the query plan. A model that references 3 views might actually execute a query touching 30 tables through nested view expansion. This is invisible at the dbt source level and is frequently the root cause of performance problems.

**Analogy**: JIT method inlining. The source shows one function call; the JIT inlines it into a deep chain. A source-level profiler misses the real cost.

**Direction**: After `decompose_query` builds the compile-time DAG, optionally expand ref/source nodes by fetching view definitions from the database (`information_schema.views`, `SHOW CREATE VIEW`, etc.). For each ref that resolves to a view, recurse — adding "ghost nodes" to the TreeView:

- **Solid nodes**: CTEs (your code, full debug symbols)
- **Dashed/dimmed nodes**: Inlined view layers (database code, no symbols)
- **Terminal nodes**: Actual tables (data boundary)

Row count estimates from `EXPLAIN` or table stats would annotate each node. The TreeView toggle gains a third mode: "Include Views."

No architectural changes needed — the TreeView's node model uses a discriminated union that accepts additional node types. The database provider already supports describe/catalog queries. This is purely additive.

## File Map

| File | Role |
|------|------|
| `src/dbt/debug-adapter.ts` | DAP adapter — handles all protocol requests, manages frames/clauses/stepping |
| `src/dbt/debug-symbols.ts` | Symbol injection (`injectMarkers`) and source map parsing (`parseSourceMap`) |
| `src/dbt/debug-pipeline-provider.ts` | TreeView provider for the Data Pipeline view in the Debug sidebar |
| `src/dbt/debug-config-provider.ts` | Debug configuration provider (launch config resolution) |
| `resources/bridge/bridge.py` | Python bridge — `emit_debug_symbols` (tokenization), `decompose_query` (AST → frames/clauses/refs) |
