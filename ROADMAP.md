# Roadmap

Ideas and planned work for the extension. Rough notes, not commitments — discussion and contributions welcome. Items marked _(done)_ have shipped and are kept here for context.

## Graph lineage, for aggregations _(done)_

Currently it can provide a trace through the model on a column level for concatenated columns, e.g. fullname -> firstname, lastname.
However,it can't visualize aggregations correctly, like count(orders). It should be able to at least visualize these aggregations somehow. Maybe a dotted line or something to the model where it is origin is (like orders for count(orders))

## Process bridge improvement considerations _(done)_

They're completely separable. The four sqlglot handlers (parse_document, get_column_lineage, get_scope_columns, get_columns) are:

Zero dbt imports
Zero filesystem access
Zero database access
Zero shared mutable state between handlers
All data comes from the request JSON, all work is local
They could run in a second bridge process that doesn't even import dbt. The current serialization is an artifact of everything going through one process and one stdin pipe — not a requirement.

Two options:

A) Second Python process — spawn a "sqlglot worker" alongside the existing bridge. Same Python, same vendored sqlglot, no dbt. Give it its own BridgeRunner. Parse/scope_columns/lineage go there, dbt commands go to the existing bridge. Both can run simultaneously.

B) Async dispatch in the existing bridge — use threading or asyncio to handle sqlglot requests while a dbt command is running. More complex, same process.

Option A is simpler and cleaner — two processes, clear separation, no threading concerns. The only cost is a second Python process (~30-50MB of memory, but no dbt import so startup is fast).

This would mean: a hover during a dbt run doesn't have to wait for the run to finish. parse_document and scope_columns would be completely non-blocking relative to dbt commands.

## Build profiler _(done)_

Have something running in the background that can profile models in the database.

## Unit testing

Code action > Generate unit test for this model/CTE.

## copilot tools

It's a pretty big difference between running the copilot tools in the extension vs how they felt when running them with MCP. The progress reporting was way better with the old MCP tools. However, now that we are INSIDE vscode, with an extension I expect us to be able to improve on the visual feedback of the tools. Lets investigate this and figure out a good progress reporting for the tools like test/run/build etc.

## No more fluff

Make replacement for SQL fluff. Completely. Formatting and .. well we have syntax checks already. However, we might want to see if we can do a semantic or pattern type of checks too .. maybe (otherwise we can just use sqlfluff for some of these checks). But i mean, we have the parser. how hard can it be :D

## Cool new provider features

VS Code has a rich context menu of language features. We already cover most of them, but a few are missing or incomplete.

**Missing providers:**

- [x] **Call Hierarchy** (`CallHierarchyProvider`) — "Show Call Hierarchy" (Shift+Alt+H). Re-invent call stack but for dbt — lineage surfaced the way a coder would have it. Native tree panel with incoming callers (who refs this model) and outgoing calls (what this model refs). Keyboard-driven, not a graph.
- [ ] **Document Highlights** (`DocumentHighlightProvider`) — powers "Change All Occurrences" (Ctrl+F2). Highlights same-symbol occurrences in the file. Without it, Ctrl+F2 falls back to dumb text matching.
- [ ] **Type Definition** (`TypeDefinitionProvider`) — "Go to Type Definition". Cursor on a column → jump to its schema.yml definition. Or cursor on a `ref()` → jump to the YAML model entry instead of the .sql file.
- [ ] **Refactor code actions** (`CodeActionKind.Refactor`) — "Refactor..." sub-menu. Extract selection into a new CTE, inline a CTE, extract model into a separate file.

**Incomplete providers:**

- [x] **Rename** — currently only renames `ref('model')` and the .sql file. Should also rename CTE names (with all in-file references), column aliases, source names, and macro names.

## Structure-aware smart completion

Because we have a real SQL parser (sqlglot), completions can understand query structure and apply coordinated edits — not just insert text at the cursor. VS Code's `CompletionItem.additionalTextEdits` lets a completion atomically edit multiple locations in the document when accepted, exactly like TypeScript auto-imports.

**Examples:**

- **Auto GROUP BY** — complete a non-aggregated column in a SELECT that has a GROUP BY clause → automatically appends the column to the GROUP BY list. Pick the column once, both places update.
- **Aggregate awareness** — complete `sum(x)` or similar → any non-aggregated columns already in the SELECT get added to GROUP BY automatically.
- **Alias propagation** — complete a column alias in SELECT → offer to update matching `ORDER BY` / `HAVING` references to use the new alias.
- **CTE skeleton** — complete a CTE name that doesn't exist yet → auto-insert `with cte_name as (\n  \n)` scaffold at the top of the query.

The code action (lightbulb) variant makes sense for *existing* SQL that already has the problem (e.g. "column in SELECT not in GROUP BY"). Smart completion handles the *as-you-type* case. Both are worth implementing — they cover different moments in the workflow.

## Heat map

Heat or flame maps .. for the model. It would be cool if the tree could visualize how many dependencies and dependents it has .. colorful in the model explorer perhaps. Something that could be toggled on/off perhaps. Also could imagine some sort of github green matrix view on some of, just have to come up with a cool usecase for it. Like, visualizing the entire model (all 2000 models and sources) etc .. in some sort of .. don't know visual that is sqarish .. need more thinking obviously :D

## dbt profiles

Support selection of different profiles from the project and user home. Different environments basically. Also with authentication support (when not using PAC). In addition to that, would imply that we can also implement deffer for dbt commands that can use it. And important aspect of when doing this is that we need to be able to classify different environments as dev, test, prod environments and similar. This ultimately opens up for monitoring of the environments, but that is very database dependent and there are probably better tools for that.

## Yaml models and sources

We have to make SQL and YAML play better togeter. For a model, they are one and the same and just two different views. Its almost like the code-behind views we had in visual studio back in the days (winforms). So navigation should be seamless .. it should offer

## World-class query result view _(done)_

Rewrote the query result webview from scratch. Goal: best table view outside of Excel — sleek, minimal UI with contextual power features.

**Data plumbing:**
- `QueryResult` interface extended with optional `columnTypes: Record<string, string>`
- Databricks provider extracts `type_name` from REST API manifest schema
- Type inference from JSON values (number, boolean, date/datetime, string) as fallback

**Features delivered:**

| Feature | Details |
|---|---|
| **Column resize** | Drag handles on column headers; double-click to auto-fit |
| **Type-aware formatting** | Right-aligned numbers (tabular-nums), centered booleans; resolves DB types + infers from values |
| **Keyboard navigation** | Arrow keys, Tab/Shift+Tab, Enter/Space to copy, Ctrl+A select-all, Ctrl+C copy |
| **Rectangular selection** | Click, Shift+click to extend, click+drag for range; column header click selects entire column |
| **Floating toolbar** | Appears on multi-cell selection with Copy, CSV, JSON, TSV, Markdown, Open in Editor |
| **Context menu** | Right-click for cell copy, selection copy, and all export formats |
| **Footer selection stats** | Shows dimensions (3×5), cell count, Sum and Avg for numeric selections |
| **Column stats bar** | Toggle via Σ button — shows min/max/mean for numbers, true% for booleans, distinct count for strings, date ranges |
| **Smart filter** | Type to activate; DSL: `col: >100`, `col: contains text`, `col: != null`, or plain text search across all columns |
| **Cell detail popup** | Hover popup showing full value, DB type badge, percentile for numbers, relative time for dates |
| **Multi-format export** | CSV, TSV, JSON, Markdown, and "Open in Editor" — from toolbar, context menu, or footer |
| **Sort improvements** | NULLs sort to bottom; re-indexes data after sort for correct selection behavior |

## Model editors _(done)_

Please remove the top codelense because we have the buttons in the editor/title that works just fine.
Also no "icons" in the Code lense. Use Text and ... to signify that it's a command.

## Profiler fix _(done)_
I don't like how the checkmark is shown. We can use a small green circle instead.
We should add the full model node at the end, directly when we first open the tree and start running. it's uggly when it's added in the end.
On the containing treenode (root) we don't have to show any status at all, just the model name.

## Debug _(done)_

It was suggested I'd implement breakpoints. Not sure how I would do it, but since we have the debugger interface implemented, we could just as well use it. Can do it on a CTE level, as well as line level. Up to us how we do it, and what we make out of it. But it's a cool idea that I haven't seen elsewhere. Also with cache, this can be really rewarding and we can do stuff stepping back, that many can't do .. which is cool.

For debugging, dynamic breaks .. i could imagine pausing on events we emit, like before parse, after parse, etc. Like we create our own stuff for that.

## More checks

Known problems colliding with our SQL registration (and isn't needed).
Better Jinja
SQLFluff
Better Yaml (or something like that). But then we need to make sure we support.

If we can't handle this, we have to investigate how we can make sure we "win" over them :D

## DBT Metric Flow

Just do it! Work together with Microsoft on this feature to surface in Fabric and replace runtime of metric flow.

Implement the thrift server side of the protocol. Call from PBI and execute your models right in the editor based on the yaml at hand.
Then turn it around and execute the thrift client to query the server. So the user interface will be in the editor too. Can then talk locally, or actually to the server.

After that we investigate other client/server protocol. Everyone seem to have invented their own for this. The only fixed point is the yaml->sql part that we will need to implement.

Last step, make it a service that can be deployed. As an example, to azure function or similar.


## Lineage bands

Color the background of lineage graph so that level-1, -2 etc have different vertical bands so we can see what models belong to which depth. Will help identify stuff...

## Whitespace commit support

Since we provide a formatter and autofixing as part of Ninja, it is probably good if we can think about how to handle whitespace commits. We should consider if we should use some git best practice around this and help the users with it. As an example, if the user chooses to format a model, and want to separate that from actual logical changes, maybe help them by doing a commit for it. Could be that we create a commit for whitespace in the beginning, with basically nothing (empty) and then we keep amending that witch whitespace commits to help the users. Or something like that. So basically, if we format, we check vs git somehow .. and if there is mixed logic and whitespace we detect that, take the origin out, format that, commits that in our whitespace commit (ammend) and then apply the logic on the fomrmatted version. Or something like that. Can be different strateiges, but it usually helps with reviews. SQL formatting can be brutal when you apply it so it is a bit unusual situation compared to some code (the community is less aware).
