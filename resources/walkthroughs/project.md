## Open your dbt project

dbt Anvil turns on the moment your workspace contains a `dbt_project.yml`. Everything else on this list follows from that.

If this step is unchecked, you have the extension installed but no dbt project open. Open the folder that holds your `dbt_project.yml` (File then Open Folder), and the extension activates and starts indexing on its own.

Once a project is open, Anvil detects your Python environment, checks that dbt is installed, installs packages, and parses the project. The steps below track that work as it happens, and check themselves off as each one clears.
