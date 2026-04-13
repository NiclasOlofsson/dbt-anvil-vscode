# dbt Studio

A VS Code extension that gives dbt the same kind of language support that most programming languages have had for years. Now it's here, for dbt Core.

If you work with TypeScript or Python in VS Code, you take column completions, go-to-definition, and inline diagnostics for granted. dbt projects haven't had any of that. dbt Studio changes that — column intelligence, interactive lineage, an integrated test runner, and Copilot tools that can query your warehouse and trace your DAG.

No configuration. Open a dbt project and everything works.

![dbt Studio demo](https://raw.githubusercontent.com/NiclasOlofsson/dbt-studio/main/demo.webp)

## Column Intelligence

dbt Studio parses your models and knows their columns. Type in a SELECT and you get completions from the actual columns defined upstream. Hover over a column name to see where it comes from. Rename it and every reference updates.

This works through refs, sources, CTEs, and joins — across your entire project.

## Jinja

Most SQL tooling treats Jinja as noise and breaks the moment it hits a `{% if %}` block. dbt Studio understands Jinja as a distinct layer on top of SQL and keeps working correctly underneath it — completions, hover, diagnostics, and go-to-definition all function normally inside conditional blocks and loop bodies.

Macro calls get signature help as you type. Both Jinja-SQL and Jinja-in-YAML have dedicated grammars, so highlighting is accurate in model files and schema definitions alike.

dbt Studio is, quietly, a Jinja ninja.

## Lineage

An interactive graph that follows your editor. Open a model and see its upstream and downstream dependencies in a side panel. Click into column-level lineage to trace individual columns through the DAG.

Column lineage is parsed — not pattern-matched. No regular expressions trying to guess what your SQL means. For a developer who's spent time debugging why a regex-based lineage tool got confused by a subquery, this is roughly what oat milk is to someone who's lactose intolerant: it just works, nobody gets a stomachache, and you stop thinking about it.

Also fast. Noticeably fast.

## SQL Editor

dbt Studio includes a SQL editor for running ad-hoc queries directly against your warehouse. Open any `.sql` file outside your models folder, write a query, and press F5. Results appear in a panel immediately — with row numbers, a stats summary, and selection-aware copy and export.

Vanilla SQL or Jinja macros — it doesn't matter. dbt Studio compiles Jinja before sending the query, so you can write `{{ ref('orders') }}` or `{{ my_macro() }}` in a scratch file and it just works.

Useful for exploration, debugging, and verifying what a compiled query actually returns before you build it into a model.

## Debugger

The traditional approach to debugging a dbt model is to paste a CTE into a scratch file, run it, look at the results, paste the next one, and repeat until you find the join that multiplied your row count by twelve. This is fine. People do this daily. There is a better way.

Press F5 and the model pauses at entry. F10 steps to the next CTE, executing it and showing what came out. F11 steps into a CTE's individual clauses — `FROM`, `WHERE`, `GROUP BY`, `SELECT` — so you can watch the row count change at each step. The Data Pipeline view marks the exact clause where things went sideways.

Step Back replays cached results, so it's free. Breakpoints work by CTE name or line. Edit a CTE mid-session and Restart Frame recompiles just that piece. Step Into a `ref()` and it opens a nested session for that model.

It implements the [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/), so the toolbar, the variables panel, the call stack — it's the standard VS Code debugger. Just for SQL now.

## Profiler

Not a real profiler. A real profiler instruments query plans, tracks memory allocation, and produces flame graphs. This is not that.

What it _is_: a tool that runs each CTE in your model separately and tells you how many rows it produced and how long it took. That's often enough to find the CTE that's scanning 40 million rows when it should be scanning 40. Results appear in a sidebar tree, and gutter icons mark the hot and warm CTEs directly in the editor so you can spot the expensive ones without leaving the file.

Think of it as a map drawn on a napkin — not GPS, but it'll get you to the right neighbourhood.

## Testing

Let's be honest — most dbt tests are data quality checks. `not_null`. `unique`. The occasional `accepted_values`. Useful, sure, but not exactly what a developer means when they say "I want to test my logic."

dbt does have unit tests now, and they are what developers actually want. Someone has to write them though, and that someone is you. dbt Studio at least makes running them less painful: results show up in a sidebar with pass, fail, and warn grouped by status, and the real error output is right there without digging through terminal logs.

You can also test individual CTEs in isolation using the `model::cte_name` convention — useful when a model has complex intermediate steps and you want to verify one of them without running the whole thing.

Tests integrate with VS Code's native Test Controller, so the Testing panel works too. No excuses left, really.

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

You've read the prose. You skipped to here anyway. Fine.

- Column completions — `ref()`, `source()`, Jinja blocks, column names, YAML schema
- Hover info — model details, column metadata, source descriptions
- Go to definition for models, sources, and macros
- Find all references for models, sources, CTEs, and column aliases
- Rename with F2 — models (including the file), CTEs, column aliases, and inline aliases
- Call hierarchy — see which models reference yours, and which models yours references
- Diagnostics — parse errors, unresolved refs, column mismatches, SQL syntax errors
- Inline / restore ref — quick-fix to expand a `ref()` to its compiled SQL or restore it
- Quick Fix — create missing model files from unresolved refs
- CodeLens — per-CTE query actions inline above each CTE definition
- Document symbols — navigate CTEs and model structure via the outline
- Workspace symbols — find any model or source by name (Ctrl+T)
- Signature help for Jinja macros
- Syntax highlighting for Jinja SQL and Jinja in YAML
- Interactive lineage graph — model-level and column-level, follows your active editor
- SQL editor — run ad-hoc queries with F5, results panel with stats, copy, and export
- CTE Profiler — per-CTE row counts and timing, gutter icons, sidebar summary
- SQL Debugger — step through CTEs and clauses with F10/F11, inspect intermediate results, step back for free, breakpoints by name or line, edit and continue, cross-model step-in
- Model Explorer — browse the project tree with materialisation icons
- Test Explorer — pass/fail/warn by status, integrates with VS Code Testing panel
- Copilot tools — 14 tools for project info, lineage, queries, and dbt execution

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

- VS Code 1.115.0 or later
- Python environment with `dbt-core` installed
- GitHub Copilot (optional — needed for AI tools)

## License

MIT
