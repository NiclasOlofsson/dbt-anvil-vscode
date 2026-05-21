# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Development
npm run watch          # Watch mode: esbuild + tsc --noEmit in parallel (primary dev loop)
npm run watch:lint     # Optional: run ESLint on save (separate process, opt-in)
npm run compile        # Single dev build with source maps
npm run build          # Production build (no source maps)
npm run clean          # Remove dist/ and out/
npm run typecheck      # TypeScript type-check only

# Quality
npm run lint           # Check for lint errors
npm run lint:fix       # Auto-fix lint errors

# Tests
npm test                              # Run full vitest suite
npm run test:watch                    # Watch mode
npx vitest run src/path/to/file.test.ts   # Single file
npx vitest run -t "test name pattern"     # Filter by test name

# Before committing
npm run lint && npm run typecheck && npm test

# Packaging
npm run package:marketplace    # Bump patch version + create .vsix
```

Press **F5** in VS Code to launch the Extension Development Host after starting `npm run watch`.

## Architecture

dbt Studio is a VS Code extension (TypeScript + persistent Python subprocess) providing language intelligence for [dbt Core](https://docs.getdbt.com/) projects. It activates when a workspace contains `dbt_project.yml`.

### Entry Points

- `src/extension.ts` — `activate()` function; wires up all services and providers (the authoritative wiring blueprint — read this first when tracing how a feature is hooked up)
- `src/ftl/pyodide-worker.ts` — Worker pool entry point for WASM-based SQL parsing
- `src/mcp/proxy/index.ts` — Stdio ↔ HTTP proxy Claude Code spawns as its MCP server

All three are bundled by esbuild (`.esbuild.ts`) into `dist/`.

### Activation sequence

1. Create `ServiceContainer` (singleton, lazy-initialized)
2. Load `dbt_project.yml` via `DbtProjectService`
3. Detect Python env (venv/uv/poetry/pipenv/conda) and validate dbt installation — **runs off the critical path (async)**
4. Load `manifest.json` and build in-memory DAG + symbol tables (`ManifestIndexer`)
5. Spawn `bridge.py` as a persistent Python subprocess (JSON RPC over stdin/stdout)
6. Initialize Pyodide WASM worker pool for SQL parsing
7. Start MCP subsystem: HTTP server on an ephemeral 127.0.0.1 port, write discovery file at `~/.dbt-studio/mcp/<workspace-hash>.json`, upsert `~/.claude.json` per-project entry pointing at `dist/mcp-proxy.js`
8. Register all language providers, tree views, debug adapter, and language-model tools (Copilot + MCP)

### Core layers

| Layer | Key files | Role |
|---|---|---|
| **Python bridge** | `src/dbt/bridge-runner.ts`, `src/dbt/execution-service.ts` | Single persistent Python process. `DbtExecutionService` wraps it in a 4-level priority queue (background < provider < tool < user) with deduplication for idempotent jobs |
| **Manifest & indexing** | `src/indexing/` | Loads `manifest.json`, builds DAG, tracks file hashes to avoid redundant re-indexes |
| **SQL parsing (FTL)** | `src/ftl/` | Pyodide worker pool running sqlglot (WASM Python). Two-pass: fast structural AST, then async enrichment with column metadata |
| **Language providers** | `src/providers/sql/`, `src/providers/yaml/` | All VS Code language features (completion, hover, definition, rename, diagnostics, code lens). Providers are re-registered dynamically when project paths change |
| **Ninja linter** | `src/ninja/` | ~40 built-in SQL style/quality rules; full-workspace scanner; separate editor panel |
| **Views & UI** | `src/views/` | Model Explorer, interactive lineage graph (D3/dagre), test explorer, profiler results, query result panel |
| **Copilot tools** | `src/tools/` | Language model tools in 4 toolsets: Project & Resources, Lineage & Impact, Database, Execution. One file per tool — add new ones via `src/tools/index.ts` |
| **MCP subsystem** | `src/mcp/` | Exposes the same tools to Claude Code (and any MCP client) via a stdio proxy → in-host HTTP server. Shares the registry with Copilot so schemas never drift |
| **Debug adapter** | `src/dbt/debug-adapter.ts` | Debug Adapter Protocol for CTE stepping |
| **Caching** | `src/dbt/compile-cache.ts`, `src/dbt/describe-cache.ts`, persistence files | Compile results, column metadata, and parse results all persisted to disk with mtime/hash validation |

### Key architectural patterns

- **ServiceContainer** — Single singleton that holds all long-lived services; never construct services outside it
- **Priority queue** — All dbt execution goes through `DbtExecutionService`; do not spawn subprocesses directly
- **Two-layer parsing** — Fast Pyodide AST pass first, then async DB enrichment; providers must tolerate partially-enriched data
- **Persistent caches** — Compile, column, and diagnostics caches survive restarts; always validate with mtime or content hash before trusting
- **Dynamic provider registration** — Language providers are disposable; they are torn down and re-created when the active dbt project changes
- **Single tool registry** — `src/mcp/host/registry.ts` is the source of truth; Copilot (`vscode.lm.registerTool`) and MCP are thin adapters over the same `vscode.LanguageModelTool` instances. Adding a tool means adding a registry entry, not two parallel handlers

## Build

esbuild bundles three targets from `.esbuild.ts`:
- `src/extension.ts` → `dist/extension.js` (Node 18, CJS)
- `src/ftl/pyodide-worker.ts` → `dist/pyodide-worker.js`
- `src/mcp/proxy/index.ts` → `dist/mcp-proxy.js` (Node 18, CJS, fully self-contained — no externals, no `vscode` import)

Externals (extension + worker only): `vscode`, `@duckdb/*`, `*.node`, `pyodide`. The MCP proxy bundles everything so it runs as a standalone subprocess outside the extension host.
