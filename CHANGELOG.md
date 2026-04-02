# Changelog

## 0.1.7

- **Terminal dbt command detection** — dbt Studio now monitors your integrated terminal for `dbt run`, `build`, `seed`, `snapshot`, `clone`, and `run-operation` commands. When one is detected, background operations are automatically suspended so they don't race against the terminal process and corrupt the manifest. Once the command finishes, the extension resumes and immediately re-indexes the manifest to pick up any changes. Can be disabled via `dbt-studio.terminal.externalCommandMonitor.enabled` if VS Code shell integration causes unrelated problems in your environment.

## 0.1.6

This release is a significant step under the hood. The entire SQL analysis layer has been rewritten around sqlglot — no more regular expressions. Every hover, definition, diagnostic, and rename result comes from a proper parse tree, which means far fewer false positives and no more features silently falling back to guesswork. Jinja handling is also much improved, so mixed Jinja/SQL files are parsed more accurately. Caching has been overhauled too, so the extension stays fast even in large projects. On top of that, there's a genuinely useful new SQL editor for running ad-hoc queries and a round of editor experience improvements that make day-to-day work smoother.

- **SQL editor for ad-hoc queries** — A dedicated SQL editor and result panel for running queries directly against your warehouse, without going through a dbt model. Open a scratch SQL file, run it with a single command, and results appear in the panel immediately. Per-row gutter numbers, a toggleable stats summary, and a cleaner toolbar make it easy to inspect what came back. Copy and export are selection-aware — only the selected rows are included. An export save-as dialog lets you choose the output path. A new entry in the Run and Debug picker provides quick access, and the `resultLocation` launch config option lets you route results to a custom destination.
- **CTE Profiler overhaul** — The profiler tree view is completely rebuilt. Gutter icons and the overview ruler now mark hot and warm CTEs directly in the editor so you can see the cost distribution without leaving the file. Decorations can be toggled on and off. On Databricks the profiler issues a `REFRESH TABLE` hint before each run so results reflect actual execution time, not cached reads.
- **SQL syntax diagnostics** — SQL syntax errors are flagged inline as you type, powered by sqlglot. Whitespace-only changes skip re-validation.
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
