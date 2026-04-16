---
name: dbt-studio-logs
description: "Read dbt Studio VS Code extension output logs to self-diagnose errors without waiting for the user to paste them. USE FOR: workspace scanner errors, Ninja rule failures, extension crashes, parse errors, any error in the dbt Studio extension. DO NOT USE FOR: other extensions, system logs, Git logs."
---

# dbt Studio Extension Log Reader

This skill enables you to fetch the `dbt Studio` output channel log directly from disk, so you can diagnose errors autonomously.

## Log File Location

VS Code writes each extension's output channel to a timestamped session folder:

```
%APPDATA%\Code - Insiders\logs\<session>\<window>\exthost\nickeolofsson.dbt-studio-vscode\dbt Studio.log
```

| Segment | Details |
|---------|---------|
| `%APPDATA%` | `c:\Users\nicke\AppData\Roaming` |
| `<session>` | Newest folder named `YYYYMMDDTHHmmss`, e.g. `20260416T005059` |
| `<window>` | Folder named `window<N>` — use the one whose `exthost/` subtree contains `nickeolofsson.dbt-studio-vscode/` |
| Log file | `dbt Studio.log` (with the space) |

### Step-by-step: find the log

**Step 1 — List session folders (newest last)**

```bash
ls "c:/Users/nicke/AppData/Roaming/Code - Insiders/logs/"
```

Take the lexicographically last folder (highest timestamp).

**Step 2 — Find the right window**

```bash
ls "c:/Users/nicke/AppData/Roaming/Code - Insiders/logs/<session>/"
```

Try the highest-numbered window first (most recently opened). Check if it has the extension dir:

```bash
ls "c:/Users/nicke/AppData/Roaming/Code - Insiders/logs/<session>/<window>/exthost/"
```

Look for `nickeolofsson.dbt-studio-vscode/` in the listing. If not present, try the next-highest window number.

**Step 3 — Read the log**

```bash
tail -100 "c:/Users/nicke/AppData/Roaming/Code - Insiders/logs/<session>/<window>/exthost/nickeolofsson.dbt-studio-vscode/dbt Studio.log"
```

Use `read_file` with `startLine` near the end for targeted reading without truncation. The file grows continuously during a session.

**Full concrete example** (substitute the actual session/window):

```
c:/Users/nicke/AppData/Roaming/Code - Insiders/logs/20260416T005059/window28/exthost/nickeolofsson.dbt-studio-vscode/dbt Studio.log
```

## Key Log Patterns

### Workspace scanner errors

```
[debug] [workspace-scanner] error scanning <path>: Error: [rule:<rule-id>] <message>
```

`[rule:<rule-id>]` is injected by `engine.ts`'s per-rule try/catch. Use this to identify which Ninja rule is failing.

### Rule IDs to know

| Rule ID | File | What it does |
|---------|------|--------------|
| `ninja.aliasing.expression-no-alias` | `alias-expression-no-alias.ts` | Checks expressions in SELECT lack an alias; uses `col.line`, `col.col`, `col.endLine`, `col.endCol` from AST |
| `ninja.aliasing.column-as` | `alias-column-as.ts` | Checks `AS` keyword casing; uses `col.aliasLine`, `col.aliasCol` |
| `ninja.structure.unused-columns` | `unused-columns.ts` | Checks for unused CTEs/columns; uses AST positions |
| `ninja.ambiguity.qualified-columns` | `ambiguity-qualified-columns.ts` | Uses `document.offsetAt(colRef.line, colRef.col)` from AST |

### Parse-related messages

```
[trace] [parse-service] parsed <path> — N CTEs, M refs ...
[debug] [parse-service] pass 2 render failed for <path>: ...
```

### Extension startup

```
[info] dbt Studio v<version> activated.
[debug] [workspace-scanner] found N SQL files in model/analysis dirs
```

## Root Cause: Pass 2 Column Positions

When a SQL file contains heavy Jinja and fails parse passes 1 and 1b, the parser falls through to **pass 2** (nunjucks render). The rendered SQL is a different string than the raw SQL. `remapAstLines()` remaps *line numbers* only — *column numbers* remain in rendered-space and can be invalid positions in the raw text. This causes `tokenRange()` and `document.offsetAt()` to throw `"Illegal argument: character must be non-negative"`.

Any Ninja rule that reads `col.col`, `col.aliasCol`, `col.endCol`, `colRef.col` etc. from `model.finalSelect.columns` may throw on pass-2 files.

## How to Use This Skill

1. Run the `ls` + `tail` sequence above to read the log.
2. Search for `[workspace-scanner] error scanning` lines.
3. Note the `[rule:<id>]` prefix to identify the failing rule.
4. Cross-reference with the rule table above to find the source file.
5. Report findings and proceed with the fix.

## Grep Search Alternative

Use `grep_search` against the log file path with query `workspace-scanner.*error` (isRegexp: true) to get just the error lines without reading the full file.
