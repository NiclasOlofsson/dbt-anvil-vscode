import { describe, expect, it } from 'vitest';
import type { Dialect, SchemaMapping } from 'sqllens';
import { traceColumnLineage, type Transformation } from './lineage';

function trace(sql: string, column: string, dialect: Dialect = 'databricks', schema?: SchemaMapping) {
	return traceColumnLineage(sql, column, dialect, schema);
}

function byId(transforms: Transformation[], id: string): Transformation | undefined {
	return transforms.find(t => t.id === id);
}

describe('traceColumnLineage — hop chain', () => {
	// The plan's canonical case: two chained CTEs with a computed expression in each.
	const canonical = 'WITH a AS (SELECT x+1 AS y FROM t), b AS (SELECT y*2 AS z FROM a) SELECT z FROM b';

	it('reaches the base-table column through both CTE hops', () => {
		const result = trace(canonical, 'z');
		expect(result.dependencies).toEqual([{ column: 'x', table: 't' }]);
		expect(result.via_ctes).toEqual(['b', 'a']);
	});

	it('records the per-hop expression snippets sliced from the original sql', () => {
		const result = trace(canonical, 'z');
		const b = byId(result.transformations, 'cte:b');
		const a = byId(result.transformations, 'cte:a');
		expect(b).toMatchObject({ type: 'cte', column: 'z', expression: 'y*2' });
		expect(a).toMatchObject({ type: 'cte', column: 'y', expression: 'x+1' });
	});

	it('links each hop to the source that feeds it (structural, not string-matched)', () => {
		const result = trace(canonical, 'z');
		expect(byId(result.transformations, 'cte:b')!.sources).toEqual(['cte:a']);
		expect(byId(result.transformations, 'cte:a')!.sources).toEqual(['table:t']);
	});

	it('emits an outer_query step naming the CTE the final select reads', () => {
		const result = trace(canonical, 'z');
		const outer = byId(result.transformations, 'query');
		expect(outer).toMatchObject({ type: 'outer_query', sources: ['cte:b'] });
	});

	it('emits a table leaf transform for the base table', () => {
		const result = trace(canonical, 'z');
		expect(byId(result.transformations, 'table:t')).toMatchObject({ type: 'table', column: 'x' });
	});

	it('preserves the actual expression text with whitespace as written', () => {
		const sql = 'WITH a AS (SELECT sum(x) AS y FROM t) SELECT y FROM a';
		const result = trace(sql, 'y');
		expect(byId(result.transformations, 'cte:a')!.expression).toBe('sum(x)');
	});
});

describe('traceColumnLineage — simple SELECT', () => {
	it('depends on the source table for a bare projection', () => {
		const result = trace('SELECT customer_id FROM orders', 'customer_id');
		expect(result.dependencies).toEqual([{ column: 'customer_id', table: 'orders' }]);
		expect(result.via_ctes).toEqual([]);
		expect(byId(result.transformations, 'table:orders')).toMatchObject({ type: 'table', column: 'customer_id' });
	});

	it('carries schema on a schema-qualified base table', () => {
		const result = trace('SELECT customer_id FROM staging.raw_orders', 'customer_id');
		expect(result.dependencies).toEqual([{ column: 'customer_id', table: 'raw_orders', schema: 'staging' }]);
	});

	it('returns empty result for a column that is not projected', () => {
		const result = trace('SELECT customer_id FROM orders', 'does_not_exist');
		expect(result.dependencies).toEqual([]);
		expect(result.transformations).toEqual([]);
		expect(result.via_ctes).toEqual([]);
	});
});

describe('traceColumnLineage — JOIN', () => {
	// A qualified column from the joined table must attribute to that table, not the driver.
	const joinSql = [
		'SELECT o.order_id, c.customer_name AS name',
		'FROM orders o',
		'JOIN customers c ON c.customer_id = o.customer_id',
	].join('\n');

	it('attributes a joined-table column to the joined table', () => {
		const result = trace(joinSql, 'name');
		expect(result.dependencies).toEqual([{ column: 'customer_name', table: 'customers' }]);
		expect(byId(result.transformations, 'query')!.sources).toEqual(['table:customers']);
	});

	it('attributes the driver-table column to the driver table', () => {
		const result = trace(joinSql, 'order_id');
		expect(result.dependencies).toEqual([{ column: 'order_id', table: 'orders' }]);
	});
});

describe('traceColumnLineage — UNION', () => {
	const unionSql = [
		'WITH u AS (',
		'    SELECT customer_id FROM orders',
		'    UNION ALL',
		'    SELECT customer_id FROM archive_orders',
		')',
		'SELECT customer_id FROM u',
	].join('\n');

	it('attributes both union legs in the dependencies', () => {
		const result = trace(unionSql, 'customer_id');
		const tables = result.dependencies.map(d => d.table).sort();
		expect(tables).toEqual(['archive_orders', 'orders']);
	});

	it('emits a union transform with a branch per leg', () => {
		const result = trace(unionSql, 'customer_id');
		const union = byId(result.transformations, 'cte:u');
		expect(union?.type).toBe('union');
		expect(union?.branches).toHaveLength(2);
		const legSources = union!.branches!.flatMap(b => b.sources).sort();
		expect(legSources).toEqual(['table:archive_orders', 'table:orders']);
	});

	it('walks a top-level union (no CTE) attributing both legs', () => {
		const sql = 'SELECT id FROM a UNION ALL SELECT id FROM b';
		const result = trace(sql, 'id');
		const tables = result.dependencies.map(d => d.table).sort();
		expect(tables).toEqual(['a', 'b']);
		expect(byId(result.transformations, 'query')?.type).toBe('union');
	});
});

describe('traceColumnLineage — star expansion', () => {
	// A single-source `SELECT *` passthrough flows the column straight through — the hop is
	// walked fully (the column name passes down to the one source), no schema required.
	const starSql = 'WITH s AS (SELECT * FROM orders) SELECT customer_id FROM s';
	const schema: SchemaMapping = { orders: { customer_id: 'bigint', total: 'double' } };

	it('walks a single-source star passthrough to the base table', () => {
		const result = trace(starSql, 'customer_id', 'databricks', schema);
		expect(result.dependencies).toEqual([{ column: 'customer_id', table: 'orders' }]);
		expect(result.via_ctes).toContain('s');
		expect(byId(result.transformations, 'table:orders')).toMatchObject({ column: 'customer_id' });
	});

	it('summarizes (does not drop) a multi-source star hop that needs a schema to expand', () => {
		// `SELECT *` over a JOIN cannot be attributed without a schema — the hop is kept and
		// flagged summarized, while the flat dependencies still carry the base-table leaves.
		const joinStar = [
			'WITH s AS (SELECT * FROM orders o JOIN customers c ON c.id = o.customer_id)',
			'SELECT customer_name FROM s',
		].join('\n');
		const joinSchema: SchemaMapping = {
			orders: { order_id: 'bigint', customer_id: 'bigint' },
			customers: { id: 'bigint', customer_name: 'string' },
		};
		const result = trace(joinStar, 'customer_name', 'databricks', joinSchema);
		const s = byId(result.transformations, 'cte:s');
		expect(s).toBeDefined();
		expect(s?.summarized).toBe(true);
		// The leaf is not dropped — dependencies still resolve it via the schema-aware origin walk.
		expect(result.dependencies).toEqual([{ column: 'customer_name', table: 'customers' }]);
	});
});

describe('traceColumnLineage — schema-fed base columns', () => {
	it('binds an unqualified column across a join using the schema', () => {
		const sql = 'SELECT customer_name FROM orders o JOIN customers c ON c.id = o.customer_id';
		const schema: SchemaMapping = {
			orders: { order_id: 'bigint', customer_id: 'bigint' },
			customers: { id: 'bigint', customer_name: 'string' },
		};
		const result = trace(sql, 'customer_name', 'databricks', schema);
		expect(result.dependencies).toEqual([{ column: 'customer_name', table: 'customers' }]);
	});
});
