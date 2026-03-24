# dbt Studio for VS Code

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nickeolofsson.dbt-studio-vscode?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=nickeolofsson.dbt-studio-vscode)

**dbt Studio** brings your dbt project to life inside VS Code — with a model explorer, Jinja SQL language support, and deep GitHub Copilot integration that lets you navigate, run, and understand your dbt project through natural language.

No configuration required. Open a workspace with a `dbt_project.yml` and it just works.

## Features

### Copilot Integration (Language Model Tools)

Ask GitHub Copilot anything about your dbt project:

- **Run / Test / Build / Compile Models** — Execute dbt commands from chat
- **List Resources** — Browse models, sources, seeds, and snapshots
- **Get Resource Info** — Inspect model details, columns, and configuration
- **Get Project Info** — Overview of project statistics and structure
- **Get Lineage** — Explore upstream and downstream dependencies
- **Get Column Lineage** — Column-level lineage information
- **Analyze Impact** — Understand downstream effects of changes before you make them
- **Query Database** — Run SQL queries through dbt's connection
- **Install Dependencies** — Run `dbt deps` from chat
- **Load Seeds** — Run `dbt seed` from chat

### Model Explorer

A sidebar tree view showing all dbt resources organised by type and materialisation — models, sources, seeds, snapshots, and tests at a glance.

### Language Support

- **Jinja SQL** syntax highlighting for `.sql` files with Jinja2 templates
- **Jinja in YAML** — syntax highlighting for Jinja expressions in `schema.yml` and other dbt YAML files
- **Go to Definition** — jump from `ref('model_name')` or `source('src', 'table')` directly to the file
- **Hover Information** — see model details and metadata on hover
- **Auto-completion** for `ref()`, `source()`, and Jinja built-in functions

### Test Results

View test results in a dedicated panel with pass/fail status indicators.

## Getting Started

### 1. Install the extension

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/nickeolofsson.dbt-studio-vscode?label=Install%20from%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=nickeolofsson.dbt-studio-vscode)

Or search for **dbt Studio** in the VS Code Extensions panel.

### 2. Open a dbt project

Open any folder containing a `dbt_project.yml`. The extension activates automatically.

### 3. Ask Copilot about your project

Open GitHub Copilot Chat and ask things like:

> "List all models in my dbt project"
> "Show me the lineage for the customers model"
> "Run the staging models and show results"
> "What would break if I changed stg_orders?"

## Requirements

- VS Code 1.102.0 or later
- GitHub Copilot extension
- Python environment with `dbt-core` installed
- A dbt project in your workspace

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|

| `dbt-studio.profilesDir` | Path to the dbt profiles directory | `~/.dbt` |
| `dbt-studio.logLevel` | Log verbosity level | `info` |

## Troubleshooting

**Extension not activating?**
- Ensure your workspace contains a `dbt_project.yml` file at the root or in a subfolder.

**Copilot tools not appearing?**
- Make sure GitHub Copilot is installed and signed in.
- The tools appear as a toolset in Copilot Chat — look for the dbt Studio toolset icon.

**"dbt not found" errors?**
- The extension auto-detects your Python environment (venv, uv, poetry, pipenv, conda, system Python). Ensure dbt-core is installed in whichever environment your project uses.
- Verify dbt is installed: `python -m dbt --version`

**Manifest not loading?**
- Run `dbt compile` or `dbt run` in your project first to generate `target/manifest.json`.
- The extension watches for manifest changes and reindexes automatically.

## Development

```bash
git clone https://github.com/NiclasOlofsson/dbt-studio-vscode
cd dbt-studio-vscode
npm install
npm run compile
```

Press `F5` in VS Code to launch an Extension Development Host with the extension loaded.

```bash
npm test       # run unit tests
npm run lint   # lint
```

## License

MIT
