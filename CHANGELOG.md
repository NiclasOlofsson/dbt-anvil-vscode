# Changelog

## Unreleased

- **Multi-statement files** — scratch files with `;`-separated statements are parsed per statement; refs, tokens, and diagnostics come from every statement, not just the first.
- **Star expansion without a warehouse connection** — `select *` through CTEs and subqueries now expands from the model text alone; schema enrichment still adds warehouse columns when available.
- **Debugger internals** — symbol emission and query decomposition moved from the Python bridge to the native parser. Clause SQL is sliced from the source text at exact parser spans instead of being regenerated, so what you step through is byte-for-byte what runs.

## 0.1.14

A packaging hotfix. The `0.1.13` VSIX accidentally bundled the in-progress `experiments/` folder, the GitHub Pages site under `docs/`, and a handful of internal development docs — pushing the install size from a few megabytes to over 200. This release tightens `.vscodeignore` so only what the extension actually needs at runtime ships: `dist/`, `resources/`, `syntaxes/`, the duckdb native module, `README.md`, `CHANGELOG.md`, and `LICENSE`. Functionally identical to `0.1.13`.

## 0.1.13

The headline for this release is the new Ninja linter and the FTL parser. Ninja is now an AST-driven SQL style engine with around fifty rules, a proper rule editor, and a reflow-based formatter — `Format Document` on a SQL file does something genuinely useful now. FTL is an in-process native SQL parser that replaces the Python bridge for document parsing, which is why the editor feels noticeably faster on every keystroke. There's also a long tail of improvements across the debugger, lineage, MCP, and startup.

> **Heads up:** this is a large release and may have introduced instabilities. Every feature area can be turned on or off individually from Settings — completions, hover, diagnostics, the Ninja linter, auto-fix on save, and the rest — so if something misbehaves you can disable just that piece while keeping everything else running. If you hit a problem, please open an issue at [github.com/NiclasOlofsson/dbt-studio/issues](https://github.com/NiclasOlofsson/dbt-studio/issues).

- **Ninja linter** — A from-the-ground-up rewrite of the SQL linter. Around fifty rules now, organised across capitalisation, layout, spacing, conventions, ambiguity, aliasing, and structure. Rules are AST-aware (no more regex false positives) and Jinja-aware (conditional blocks and macro calls don't trip them up). Severity and autofix are split, so you can downgrade a rule's diagnostic without losing its quick-fix, or vice versa. A new **Ninja Rule Editor** view lets you toggle, mute, and tune rules without editing JSON. Workspace diagnostics persist across restarts.
- **Format Document for SQL** — `Shift+Alt+F` now reflows your SQL through the Ninja layout engine: indentation, comma position, operator position, indented joins/CTEs/THEN/ON, and configurable max line length. Auto-fix on save and auto-fix on format are independently controllable, with per-rule overrides. dbt Studio offers to register itself as the default SQL formatter on first run.
- **User-configurable data layers** — The Model Explorer now classifies models by user-defined layers (staging, intermediate, marts, and so on) instead of a hard-coded scheme. Configure folder patterns and naming prefixes per project, and the explorer and lineage graph follow.
- **FTL parser** — Document parsing has been moved out of the Python bridge and into an in-process native parser. This is the path that drives every keystroke — diagnostics, hover, completion, lineage. It is faster than the bridge round-trip and has no subprocess startup cost. Column lineage has also been re-implemented on top of FTL with proper AST-based scope resolution for `resolveTableRefs`.
- **Debugger: UNION-aware decomposition** — Models that use `UNION` / `UNION ALL` at the top level are now decomposed correctly, with each branch labelled by clause. The debugger also no longer writes `.vscode/launch.json` on activation, which was surprising in clean checkouts.
- **MCP integration with Claude Code** — dbt Studio's tools are now registered with Claude Code over MCP, in addition to the existing Copilot integration. Both surfaces share the same registry so schemas never drift.
- **Faster startup** — dbt and Python environment validation now runs off the activation critical path, so the extension activates and starts indexing immediately. A missing or broken Python environment surfaces a notification rather than blocking activation. `pipenv` / `uv` / `poetry` projects are auto-bootstrapped when their lockfile is present but the venv is missing.
- **Lineage polish** — Column lineage v2 produces cleaner graphs with viewport-proportional column wrapping and a relaxation pass for layout. The lineage side panel docks with center-preserving resize, and lineage graph state and layout are persisted per project.
- **Tools** — `relation_name` and `alias` are surfaced in the MCP and Copilot resource tools. Structured dbt execution events now carry job context, which is what feeds the new event console.
- **Fix: duplicate Ninja diagnostics** — Diagnostics no longer duplicate when a file is opened during a workspace scan, and stale diagnostics are cleared on file delete.
- **Fix: workspace scanner robustness** — Negative-character offsets in heavily Jinja'd files no longer crash the scanner. String literals are masked in capitalisation and spacing rules so SQL inside string constants isn't linted.

## 0.1.12

This is primarily a stability release, with improved startup resilience and several debugger enhancements.

- **Debugger: step into referenced models** — Pressing F11 on a `ref()` in a FROM or JOIN clause now opens a nested debug session for the referenced model, letting you follow the data through the full model graph without leaving the debugger.
- **Debugger: improved step-in and step-out** — Step-in and step-out navigation through CTEs and clause-level frames has been reworked for more predictable behaviour, including correct handling of the final `SELECT` clause appearing in the call stack.
- **Startup validation** — dbt Studio now validates the Python environment on startup. If it is broken or misconfigured, a warning notification appears with a one-click "Reload Window" option. Missing `dbt_packages/` is also detected and surfaces an offer to run `dbt deps` before any commands are attempted.
- **Fix: SQL identifier quoting** — Identifiers are now quoted per-adapter (double-quotes for DuckDB, backticks for Databricks) in schema and table introspection queries, fixing failures on projects with hyphenated names.
- **Fix: debugger continue** — `F5` (continue) mid-session no longer terminates the session prematurely. Navigation history is now preserved across continue calls and only reset at the start of a fresh session.
- **Fix: DuckDB file lock** — The DuckDB connection is now opened and closed per-operation instead of being held open as a singleton, eliminating the file lock conflict when running `dbt build` or `dbt seed` alongside the extension.

## 0.1.11

This release rounds out the debugger with several new DAP capabilities and fixes a handful of rough edges from the initial launch.

- **Debug console completions** — The debug console now offers completions as you type: CTE names, column aliases, SQL keywords, and dbt Jinja functions (`ref`, `source`, `config`, etc.) all surface contextually.
- **Reverse continue** — Step backwards through the CTE chain to any earlier frame. Cached results make this instant.
- **Hover evaluation** — Hovering over a column or expression in the editor during a debug session evaluates it in-place and shows the result, without touching the debug console.
- **Goto targets** — Jump directly to any CTE frame from the editor context menu during a debug session.
- **Exception breakpoints** — `setExceptionBreakpoints` is now handled so the debug adapter no longer rejects the request that VS Code sends on every session start.
- **Fix: debug console in `_main_` frame** — Evaluating expressions in the top-level (non-CTE) frame now works correctly; `@dbg` annotations are stripped before the query is sent to the warehouse.
- **Fix: encoded frame IDs** — Frame IDs containing special characters are now decoded properly in evaluate requests.
- **Fix: leading block comments** — Models that start with a `/* ... */` block comment before the `WITH` keyword are now decomposed correctly instead of being treated as a single frame.

## 0.1.10

The headline for this release is a step debugger for dbt SQL. The paste-CTE-into-scratch-file workflow has served everyone well enough, but there's now an alternative that doesn't require leaving the editor or losing your place in the model.

- **SQL Debugger** — Press F5 on any dbt model to start a debug session. F10 steps to the next CTE and shows what came out; F11 steps into clause-level execution so you can watch the row count change through `FROM → JOIN → WHERE → GROUP BY → SELECT`. Step Back replays cached results at zero cost. Breakpoints work by CTE name or line. The debug console evaluates SQL in the current CTE's scope. Edit a CTE mid-session and Restart Frame recompiles just that piece, keeping upstream results cached. Step Into a `ref()` and it opens a nested session for the referenced model.
- **Data Pipeline tree view** — A live CTE dependency DAG in the Debug sidebar that updates as you step. Any clause that produced more rows than its input gets a warning flag, so the fan-out join is usually obvious within the first few steps.
- **DuckDB native queries** — Projects targeting DuckDB now run queries directly without going through `dbt show`, the same path Databricks has had for a while. Windows only for now — other platforms are coming.

## 0.1.8

- **Fix Marketplace README image** — Demo image was not rendering on the VS Code Marketplace due to the repository being private. Images are now hosted publicly and load correctly on the extension page.

## 0.1.7

- **Terminal dbt command detection** — dbt Studio now monitors your integrated terminal for `dbt run`, `build`, `seed`, `snapshot`, `clone`, and `run-operation` commands. When one is detected, background operations are automatically suspended so they don't race against the terminal process and corrupt the manifest. Once the command finishes, the extension resumes and immediately re-indexes the manifest to pick up any changes. Can be disabled via `dbt-studio.terminal.externalCommandMonitor.enabled` if VS Code shell integration causes unrelated problems in your environment.

## 0.1.6

This release is a significant step under the hood. The entire SQL analysis layer has been rewritten around a real SQL parser — no more regular expressions. Every hover, definition, diagnostic, and rename result comes from a proper parse tree, which means far fewer false positives and no more features silently falling back to guesswork. Jinja handling is also much improved, so mixed Jinja/SQL files are parsed more accurately. Caching has been overhauled too, so the extension stays fast even in large projects. On top of that, there's a genuinely useful new SQL editor for running ad-hoc queries and a round of editor experience improvements that make day-to-day work smoother.

- **SQL editor for ad-hoc queries** — A dedicated SQL editor and result panel for running queries directly against your warehouse, without going through a dbt model. Open a scratch SQL file, run it with a single command, and results appear in the panel immediately. Per-row gutter numbers, a toggleable stats summary, and a cleaner toolbar make it easy to inspect what came back. Copy and export are selection-aware — only the selected rows are included. An export save-as dialog lets you choose the output path. A new entry in the Run and Debug picker provides quick access, and the `resultLocation` launch config option lets you route results to a custom destination.
- **CTE Profiler overhaul** — The profiler tree view is completely rebuilt. Gutter icons and the overview ruler now mark hot and warm CTEs directly in the editor so you can see the cost distribution without leaving the file. Decorations can be toggled on and off. On Databricks the profiler issues a `REFRESH TABLE` hint before each run so results reflect actual execution time, not cached reads.
- **SQL syntax diagnostics** — SQL syntax errors are flagged inline as you type. Whitespace-only changes skip re-validation.
- **Rename symbol (F2)** — Rename any CTE, column alias, or inline alias across the entire file with F2. Every reference updates in one step, the same as renaming a variable in any other language.
- **Find all references (Shift+F12)** — The References panel now lists every use of a CTE name or column alias in the current file.
- **Call hierarchy** — Peek at which dbt models reference yours, and which models yours references, directly from the editor's Go menu.
- **Inline / restore ref** — A lightbulb quick-fix lets you inline a `ref()` call to its raw compiled SQL, or restore it back. Useful for debugging what a ref resolves to without leaving the editor.
- **Rich hover cards** — Hover tooltips show icons, clickable source links, and a distinct badge for CTEs. Column and model info is much easier to read at a glance.


## 0.1.5

- **Databricks native queries** — If you're on Databricks, the extension now talks directly to the SQL Statement API instead of going through `dbt show`. Queries run faster and don't require a dbt invocation for every describe or inline execution.
- **Document outline** — CTEs and columns now appear in the breadcrumb bar and the Outline panel (Ctrl+Shift+O), each with correct source positions. Jump straight to any CTE or column definition without scrolling.
- **Feature toggles** — Every feature area (completions, hover, diagnostics, go-to-definition, etc.) can now be turned on or off individually from Settings, with immediate effect — no window reload needed. A gear icon in the Model Explorer opens the relevant settings page directly.
- **More accurate hover and go-to-definition** — Both providers are now built on the AST token index rather than text patterns. Hover info and definition jumps are more precise, and spurious matches on unrelated text are gone.
- **Smarter column diagnostics** — Unknown-column warnings are now driven by the AST instead of a text regex. Diagnostics no longer fire on JOIN conditions, Jinja expressions, or cases where the same alias is reused in a CTE body and the outer SELECT. Warning ranges point to the exact column token.

## 0.1.4

This release adds the two biggest missing pieces: a lineage graph and column intelligence.

- **Lineage graph** — An interactive DAG view that follows your editor. See upstream and downstream models for whatever file you're working on. Supports column-level lineage highlighting and depth controls.
- **Column completions** — Type a column name and get completions from the actual columns in the model, pulled from your warehouse. Works across refs, sources, CTEs, and joins.
- **Test explorer** — Run dbt tests from the sidebar and see pass/fail/warn results with real error output, instead of scrolling through terminal logs.
- **Persistent caching** — Column metadata and compiled SQL are saved to disk. Restarting VS Code no longer means waiting for everything to re-compile and re-describe.

## 0.1.2

- Reduced extension install size by excluding sample project from the package.

## 0.1.1

Column completions now pull real column metadata from the warehouse (via `dbt show`) instead of relying only on YAML definitions. Results are cached so repeated completions are instant. General responsiveness improvements — the extension cancels work immediately when you keep typing, and avoids redundant parsing when the manifest hasn't changed.

## 0.1.0

First release. The starting point:

- **Copilot tools** — 14 tools that let GitHub Copilot query your project, trace lineage, run models, and execute SQL against your warehouse.
- **Language support** — Jinja SQL syntax highlighting, go-to-definition for `ref()` and `source()`, hover info, and completions for refs, sources, and Jinja functions.
- **Model explorer** — A sidebar tree showing all models, sources, and seeds grouped by directory.
- **Test results** — A panel for viewing dbt test output.
