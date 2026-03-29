# Features to add

## Graph lineage, for aggregations
Currently it can provide a trace through the model on a column level for "asdfsf" + "adsaf" columns. Looks fancy. Example fullname -> firstname, lastname.
However,it can't visualize aggregations correctly, like count(orders). It should be able to at least visualize these aggregations somehow. Maybe a dotted line or something to the model where it is origin is (like orders for count(orders))

## Process bridge improvment considerations

(DONE)

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

## Performance info

C:\Development\dbt_oatanalytics\target\perf_info.json

Have intersting information that we should look into.

## Build profiler

Have something running in the background that can profile models in the database.

## Unit testing

Code action > Generate unit test for this model/CTE.

## copilot tools

It's a pretty big difference between running the copilot tools in the extension vs how they felt when running them with MCP. The progress reporting was way better with the old MCP tools. However, now that we are INSIDE vscode, with an extension I expect us to be able to improve on the visual feedback of the tools. Lets investigate this and figure out a good progress reporting for the tools like test/run/build etc.

