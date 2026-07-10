## Parse the project

`dbt parse` reads your models, sources, tests, and macros and writes `manifest.json`, the graph of your whole project. Anvil indexes that manifest into an in-memory DAG, which is what powers go-to-definition, completion, hover, references, rename, and lineage.

Anvil parses on startup, and again in the background whenever you save. This step checks itself off once the manifest exists and the index is built.

If lineage or completion look empty, run Parse Project to rebuild the manifest.
