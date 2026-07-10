## Connect to your warehouse

Some features read live from your warehouse: column metadata for completion and hover, table previews, and profiling. Anvil connects with the profile named in your `dbt_project.yml`, resolved from `profiles.yml`.

Test Connection runs `dbt debug`, which validates your profile and reaches the warehouse. This step checks itself off when that succeeds.

If it fails, `dbt debug` prints which part of the connection is wrong (credentials, host, database, or schema). Fix `profiles.yml` and test again.
