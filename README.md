# dbt Studio for VS Code

**dbt Studio** brings your dbt project to life inside VS Code. A full-featured development environment *and* an AI-powered assistant — the best of both worlds for analytics engineering.

No configuration required. Open a workspace with a `dbt_project.yml` and it just works.

---

## A Real Developer Experience

Everything you expect from a first-class language extension — purpose-built for dbt.

### Language Support

- **Jinja SQL syntax highlighting** for `.sql` files with full Jinja2 template support
- **Jinja in YAML** — syntax highlighting for Jinja expressions in `schema.yml` and other dbt config files
- **Go to Definition** — click through `ref('model_name')` or `source('src', 'table')` to jump straight to the file
- **Hover Information** — model details and metadata at your fingertips
- **Auto-completion** for `ref()`, `source()`, and Jinja built-in functions

### Model Explorer

A sidebar tree view showing all your dbt resources organised by type and materialisation — models, sources, seeds, snapshots, and tests at a glance.

### Lineage Graph

An interactive lineage panel that visualises upstream and downstream dependencies. Follows the active editor so the graph updates as you navigate between models.

### Test Explorer & Results

Browse, run, and inspect unit tests, data tests, and CTE tests from a dedicated sidebar. Run individual tests, groups, or everything at once — with pass/fail results in a dedicated panel.

### Editor Actions

Run, test, build, or compile the current model directly from the editor title bar — no terminal needed.

---

## AI-Powered Development with Copilot

dbt Studio provides a rich set of tools to GitHub Copilot, giving it deep understanding of your dbt project. Ask questions, run commands, explore lineage, and analyse impact — all through natural conversation.

> *"List all models in my project"*
> *"Show me the lineage for the customers model"*
> *"Run the staging models"*
> *"What would break if I changed stg_orders?"*
> *"Query the database for the top 10 customers by revenue"*

Copilot can run and build models, inspect resources, trace column-level lineage, analyse downstream impact of changes, query your database, and more — all without leaving the chat.

---

## Getting Started

1. **Install** — search for **dbt Studio** in the VS Code Extensions panel
2. **Open a dbt project** — any folder containing a `dbt_project.yml` activates the extension automatically
3. **Start coding** — language features work immediately
4. **Talk to Copilot** — open Copilot Chat to use the AI tools (requires GitHub Copilot)

### Requirements

- VS Code 1.102.0 or later
- Python environment with `dbt-core` installed
- GitHub Copilot (for AI features)

## License

MIT
