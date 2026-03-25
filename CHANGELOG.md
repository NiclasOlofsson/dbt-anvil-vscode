# Changelog

## 0.1.1

- Column completions (`alias.` → columns) now use warehouse-truth via `dbt show` with YAML as fallback
- Described columns cached per session — no repeat bridge calls after first trigger
- In-flight deduplication: VS Code's concurrent completion triggers share one bridge call
- Respect VS Code cancellation token — bail out early when user types next character
- Manifest watcher debounce (500ms) and suppress/resume during bridge calls
- Manifest loader mtime short-circuit — skip re-parse if file unchanged on disk

## 0.1.0

- Initial release
- Copilot language model tools for dbt project interaction
- Model explorer sidebar with grouped resource tree
- Jinja SQL syntax highlighting
- Go-to-definition for ref() and source()
- Hover information for model references
- Auto-completion for ref(), source(), and Jinja functions
- Test results panel
