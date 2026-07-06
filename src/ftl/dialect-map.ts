/**
 * Map a dbt adapter type to the canonical dialect name.
 * Most adapter names match the standard dialect names; this handles the exceptions.
 * Lives in src/ftl/ because FtlDocumentParser is the SQL parsing boundary.
 */
export function mapAdapterToDialect(adapterType: string | undefined): string | undefined {
	if (!adapterType) return undefined;

	const map: Record<string, string> = {
		athena: 'athena',
		bigquery: 'bigquery',
		clickhouse: 'clickhouse',
		databricks: 'databricks',
		doris: 'doris',
		dremio: 'dremio',
		duckdb: 'duckdb',
		fabric: 'fabric',
		hive: 'hive',
		materialize: 'materialize',
		mysql: 'mysql',
		oracle: 'oracle',
		postgres: 'postgres',
		postgresql: 'postgres',
		redshift: 'redshift',
		risingwave: 'risingwave',
		singlestore: 'singlestore',
		snowflake: 'snowflake',
		spark: 'spark',
		sqlite: 'sqlite',
		starrocks: 'starrocks',
		teradata: 'teradata',
		trino: 'trino',
		// Adapters needing explicit dialect mapping
		synapse: 'tsql',
		sqlserver: 'tsql',
		glue: 'spark',
		fabricspark: 'spark',
	};
	return map[adapterType.toLowerCase()] ?? adapterType.toLowerCase();
}
