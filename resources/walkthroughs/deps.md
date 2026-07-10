## Install dbt packages

dbt projects declare package dependencies (dbt_utils, dbt_expectations, and the like) in `packages.yml` or `dependencies.yml`. `dbt deps` downloads them into `dbt_packages/`.

Anvil runs this for you on startup when `dbt_packages/` is missing. This step checks itself off once the packages are present.

Run it by hand any time with the Install Dependencies button, for example after you add a package to `packages.yml`.
