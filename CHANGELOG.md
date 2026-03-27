# Changelog

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
