# dbt Studio for VS Code

A VS Code extension that brings dbt project intelligence directly into your editor, powered by GitHub Copilot language model tools.

## Features

### Copilot Integration (Language Model Tools)

Interact with your dbt project through natural language in GitHub Copilot chat:

- **Run / Test / Build Models** — Execute dbt commands from chat
- **List Resources** — Browse models, sources, seeds, and snapshots
- **Get Resource Info** — Inspect model details, columns, and configuration
- **Get Project Info** — Overview of project statistics
- **Get Lineage** — Explore upstream and downstream dependencies
- **Get Column Lineage** — Column-level lineage information
- **Analyze Impact** — Understand downstream effects of changes
- **Query Database** — Run SQL queries through dbt
- **Compile Model** — View compiled SQL for any model
- **Install Dependencies** — Run `dbt deps` from chat
- **Load Seeds** — Run `dbt seed` from chat

### Model Explorer

A sidebar tree view showing all dbt resources grouped by type and materialisation.

### Language Support

- **Jinja SQL** syntax highlighting for `.sql` files with Jinja2 templates
- **Go to Definition** for `ref()` and `source()` references
- **Hover Information** showing model details
- **Auto-completion** for `ref()`, `source()`, and Jinja built-in functions

### Test Results

View test results in a dedicated panel with pass/fail status indicators.

## Requirements

- VS Code 1.102.0 or later
- Python environment with dbt-core installed
- A dbt project in your workspace
- GitHub Copilot extension (for language model tools)

## Extension Settings

| Setting | Description | Default |
|---------|-------------|---------|
| `dbt-studio.pythonPath` | Path to the Python interpreter | `python` |
| `dbt-studio.profilesDir` | Path to the dbt profiles directory | `~/.dbt` |
| `dbt-studio.logLevel` | Log verbosity level | `info` |

## Getting Started

1. Install the extension
2. Open a workspace containing a dbt project
3. Ensure `dbt-core` is installed in your Python environment
4. The extension auto-detects your project and builds a manifest index
5. Open GitHub Copilot chat and ask questions about your dbt project

## Development

```bash
npm install
npm run compile
npm test
```

## License

MIT
