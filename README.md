# dbt Studio for VS Code

**dbt Studio** goes beyond the basics. Where most dbt extensions stop at model and source completions, dbt Studio adds the things that actually make you faster — column intelligence, interactive lineage, test results, and deep Copilot integration.

No configuration required. Open a project and it just works.

---

## What Makes It Different

### Column Intelligence

Most extensions know about your models. dbt Studio knows about your *columns*.

Get completions for column names as you type — drawn from the actual shape of the model you're in. Trace any column all the way back through your lineage to where it originally comes from.

### Lineage Graph

See the full upstream and downstream picture for any model in an interactive graph. It follows wherever you are in the editor, so the view always matches what you're working on.

### Test Explorer

Run dbt tests and see results right in the sidebar — no switching to a terminal, no scrolling through logs.

### Ask Copilot About Your Project

dbt Studio gives GitHub Copilot real understanding of your project — and the ability to act on it.

> *"What would break if I changed stg_orders?"*
> *"Trace the revenue column back to its source"*
> *"Run the staging models and show me what failed"*
> *"Query the top 10 customers by lifetime value"*

---

## Everything Else You'd Expect

- Syntax highlighting for Jinja SQL and Jinja in YAML
- Jump to definition for models and sources
- Hover to see model details
- Completions for `ref()`, `source()`, and Jinja
- Model explorer in the sidebar
- Run, test, build, or compile from the editor title bar

---

## Getting Started

1. **Install** — search for **dbt Studio** in the VS Code Extensions panel
2. **Open a dbt project** — the extension activates automatically
3. **Talk to Copilot** — open Copilot Chat to use the AI tools (requires GitHub Copilot)

### Requirements

- VS Code 1.102.0 or later
- Python environment with `dbt-core` installed
- GitHub Copilot (for AI features)

## License

MIT
