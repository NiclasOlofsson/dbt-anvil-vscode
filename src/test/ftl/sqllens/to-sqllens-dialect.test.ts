/**
 * End-to-end characterization of dbt-adapter → sqllens-dialect routing — the ONE
 * dialect-dependent mapping the extension is allowed to own (Niclas's rule: dbt
 * constants → sqllens constants where naming differs; everything else lives in
 * sqllens). Pins the full chain a manifest adapter_type takes, so consolidating
 * the mapping layers cannot shift a single adapter's routing.
 */
import { describe, expect, it } from 'vitest';
import { toSqllensDialect } from '../../../ftl/sqllens/api';

describe('toSqllensDialect (dbt adapter → sqllens dialect, end to end)', () => {
	it('identity adapters route to their own dialect', () => {
		expect(toSqllensDialect('databricks')).toBe('databricks');
		expect(toSqllensDialect('snowflake')).toBe('snowflake');
		expect(toSqllensDialect('bigquery')).toBe('bigquery');
		expect(toSqllensDialect('redshift')).toBe('redshift');
		expect(toSqllensDialect('postgres')).toBe('postgres');
		expect(toSqllensDialect('duckdb')).toBe('duckdb');
		expect(toSqllensDialect('trino')).toBe('trino');
	});

	it('renamed and family adapters route via the mapping', () => {
		expect(toSqllensDialect('postgresql')).toBe('postgres');
		expect(toSqllensDialect('synapse')).toBe('tsql');
		expect(toSqllensDialect('sqlserver')).toBe('tsql');
		expect(toSqllensDialect('fabric')).toBe('tsql');
		expect(toSqllensDialect('spark')).toBe('databricks');
		expect(toSqllensDialect('glue')).toBe('databricks');
		expect(toSqllensDialect('athena')).toBe('trino');
		expect(toSqllensDialect('presto')).toBe('trino');
	});

	it('postgres-compatible adapters route to postgres while their upstream admission is pending', () => {
		expect(toSqllensDialect('materialize')).toBe('postgres');
		expect(toSqllensDialect('risingwave')).toBe('postgres');
	});

	it('unknown and unmapped adapters and absent adapter fall back to databricks (total function)', () => {
		expect(toSqllensDialect('hive')).toBe('databricks');
		expect(toSqllensDialect('spark2')).toBe('databricks');
		expect(toSqllensDialect('fabricspark')).toBe('databricks');
		expect(toSqllensDialect('clickhouse')).toBe('databricks');
		expect(toSqllensDialect('MyUnknownDb')).toBe('databricks');
		expect(toSqllensDialect(undefined)).toBe('databricks');
	});

	it('is case- and whitespace-insensitive on the adapter name (both resolution layers)', () => {
		expect(toSqllensDialect('Synapse')).toBe('tsql');
		expect(toSqllensDialect(' MATERIALIZE ')).toBe('postgres');
	});
});
