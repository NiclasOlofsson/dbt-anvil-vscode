---
applyTo: '**'
description: Workspace rules for dbt-studio-vscode
---
# Workspace Rules

## Do less defensive coding
The codebase is small and well-typed. Avoid defensive coding patterns (e.g. `if (!x) return null`) that add noise and reduce readability. If a value is unexpectedly null/undefined, it's better to throw an error than to silently return null. This also helps surface bugs during development, as the error will point to the exact line of code that needs to be fixed.
Also avoid defensive fallback patterns like actual codeflows. Its a bit try-hard attitude and it hides bugs. So if the codepath risk not returning a value rather return undefined and surface the potiental bug instead of trying to be clever and returning some fallback value.

## Work Loop

Follow this cycle for every change:

1. Edit files using the edit tools (replace_string_in_file, multi_replace_string_in_file, create_file).
2. Run `get_errors` on modified files and fix any issues before moving on.
3. Run tests with `npm test` in the foreground terminal — no flags, no watch mode, no other test runners. Read the output directly.
4. Verify scope with `git status` and `git diff --stat` before committing.

## Terminal

Run all terminal commands bare — no pipes, no redirects. The VS Code terminal requires manual approval for shell operators (`|`, `>`, `2>&1`, etc.), which blocks execution. Read stdout/stderr directly from the terminal output.

## File Editing

Use the edit tools (replace_string_in_file, multi_replace_string_in_file, create_file) for all file modifications. On this Windows environment, `sed -i` via Git Bash converts LF to CRLF, which corrupts files for subsequent edit tool calls.

## Code Style

Follow the ESLint/Stylistic configuration in `eslint.config.mjs`: single quotes, template literals only when interpolation is needed.

## HARD NO: String-scanning for insert positions

Never compute insert/edit positions by measuring raw line strings (e.g. `prevLineText.length`, `nextIndent = line.length - line.trimStart().length`). These counts include trailing comments and whitespace that produce wrong positions.

Always derive positions from `model.sqlTokens` using the utilities in `src/ninja/fix-utils.ts`:
- `lastContentTokenOnLine(tokens, line)` — last non-comment token on a line; `.col` is the insertion column
- `firstContentTokenOnLine(tokens, line)` — first non-comment token; use `tokenStartCol(t)` for its column
- `tokenStartCol(token)` — converts exclusive end col → 0-based start col
- `findExpressionEndCol(tokens, line, col, fallback)` — tracks paren depth to find true expression end

Always fall back gracefully to the AST value when `model.sqlTokens` is undefined.

## Notes
