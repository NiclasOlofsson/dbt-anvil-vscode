# Changelog

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
