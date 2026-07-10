## Python and dbt ready

Anvil runs dbt as a persistent Python subprocess, so it needs to find your Python environment and the dbt install inside it. It looks, in order, for:

- a `.venv` or `venv` directory
- `uv.lock` (uv)
- `poetry.lock` (Poetry)
- `Pipfile.lock` (pipenv)
- a conda environment
- system Python, as a fallback

When it finds a lockfile but the environment is not built yet, it bootstraps for you (`uv sync`, `poetry install`, `pipenv install`) and checks again.

If this step stays unchecked, dbt could not be run in the detected environment. Common fixes:

- add dbt to your project dependencies, then reload
- install the environment manager (uv, Poetry, pipenv) if it is missing from your PATH

Use Show Output to see exactly what Anvil tried, then Reload Window once the environment is fixed.
