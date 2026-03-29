# dbt Studio

A VS Code extension that gives dbt the same kind of language support that most programming languages have had for years. Now it's here, for dbt Core.

If you work with TypeScript or Python in VS Code, you take column completions, go-to-definition, and inline diagnostics for granted. dbt projects haven't had any of that. dbt Studio changes that — column intelligence, interactive lineage, an integrated test runner, and Copilot tools that can query your warehouse and trace your DAG.

No configuration. Open a dbt project and everything works.

## Column Intelligence

dbt Studio parses your models and knows their columns. Type in a SELECT and you get completions from the actual columns defined upstream. Hover over a column name to see where it comes from. Rename it and every reference updates.

This works through refs, sources, CTEs, and joins — across your entire project.

## Jinja

Most SQL tooling treats Jinja as noise and breaks the moment it hits a `{% if %}` block. dbt Studio understands Jinja as a distinct layer on top of SQL and keeps working correctly underneath it — completions, hover, diagnostics, and go-to-definition all function normally inside conditional blocks and loop bodies.

Macro calls get signature help as you type. Both Jinja-SQL and Jinja-in-YAML have dedicated grammars, so highlighting is accurate in model files and schema definitions alike.

## Lineage

An interactive graph that follows your editor. Open a model and see its upstream and downstream dependencies in a side panel. Click into column-level lineage to trace individual columns through the DAG.

Depth controls let you expand or collapse the view. The graph updates as you navigate between files.

## Testing

Run dbt tests from the editor. Results show up in a sidebar — pass, fail, warn — with the real error output.

dbt Studio can also test individual CTEs inside a model in isolation, using the `model::cte_name` convention. Useful when a model has complex intermediate steps you want to verify on their own.

Tests integrate with VS Code's native Test Controller, so the Testing panel works too.

## Copilot Tools

With GitHub Copilot, dbt Studio registers 14 tools that give Copilot real access to your project:

- **Project & Resources** — project info, resource listing, model/source details, dependency installation
- **Lineage & Impact** — lineage tracing, impact analysis, column-level lineage
- **Database** — run queries against your warehouse directly from chat
- **Execution** — run, test, build, compile, seed, snapshot models

Some examples:

> "What would break if I dropped customer_id from stg_orders?"
>
> "Show me the top 10 customers by lifetime value"
>
> "Run the staging models and tell me what failed"
>
> "Trace the revenue column back to its source table"

Copilot uses the tools to actually query your project and run commands — these aren't canned responses.

## Full Feature List

- Syntax highlighting for Jinja SQL and Jinja in YAML
- Go to definition for models, sources, and macros
- Hover info — model details, column metadata, source descriptions
- Completions — `ref()`, `source()`, Jinja blocks, column names, YAML schema
- Find all references for models and sources
- Rename models (including the file) and columns across the project
- CodeLens — run/test/compile actions inline above models
- Diagnostics — parse errors, unresolved refs, column mismatches
- Document symbols — navigate CTEs and model structure via the outline
- Workspace symbols — find any model or source by name (Ctrl+T)
- Signature help for Jinja macros
- Quick Fix — create missing model files from unresolved refs
- Model Explorer — browse the project tree with materialisation icons
- Test Explorer with status tracking

## Under the Hood

dbt Studio runs a Python bridge process that talks to your project over JSON stdin/stdout. It auto-detects your Python environment — venv, uv, poetry, pipenv, conda, or system Python — and bundles sqlglot for column-level lineage parsing.

Parsing is two-layered: a fast structural pass on save, plus async database enrichment for column metadata. Everything is cached to disk and survives restarts. When the cache is valid, startup is near-instant.

If your project targets Databricks, queries go directly through the SQL Statement API instead of routing through `dbt show`. Faster, and no dbt invocation needed per describe or inline execution. Direct adapters for other warehouses are on the way.

Every feature area can be turned on or off individually from Settings — completions, hover, diagnostics, go-to-definition, and the rest. Changes take effect immediately without reloading the window.

## Getting Started

1. Install **dbt Studio** from the VS Code Extensions panel
2. Open a folder containing `dbt_project.yml`
3. The extension activates and starts indexing automatically

For AI features, install GitHub Copilot.

## Requirements

- VS Code 1.102.0 or later
- Python environment with `dbt-core` installed
- GitHub Copilot (optional — needed for AI tools)

## License

MIT
