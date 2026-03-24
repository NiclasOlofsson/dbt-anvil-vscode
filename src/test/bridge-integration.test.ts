/**
 * Bridge integration tests — spawns a real bridge.py process against the
 * jaffle_shop fixture and exercises the describe_table and get_scope_columns
 * handlers end-to-end.
 *
 * These tests require dbt to be installed in the Python environment detected
 * for this repo. They will fail loudly if the environment is not set up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { BridgeRunner } from '../dbt/bridge-runner';
import { detectPythonEnvironment } from '../dbt/env-detector';
import { createMockLogger } from './helpers';

const JAFFLE_SHOP = path.join(__dirname, '..', 'fixtures', 'jaffle_shop');
const BRIDGE_PY = path.join(__dirname, '..', '..', 'resources', 'bridge', 'bridge.py');

describe('bridge integration', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
	});

	afterAll(async () => {
		await bridge.shutdown();
	});

	it('describe_table returns columns for stg_customers', async () => {
		const result = await bridge.invokeRaw({ describe_table: true, name: 'stg_customers' });
		expect(result.success).toBe(true);
		const cols = (result.data as Record<string, unknown>)['columns'] as string[];
		expect(Array.isArray(cols)).toBe(true);
		expect(cols.length).toBeGreaterThan(0);
		expect(cols).toContain('customer_id');
	}, 60_000);

	it('describe_table returns columns for stg_orders', async () => {
		const result = await bridge.invokeRaw({ describe_table: true, name: 'stg_orders' });
		expect(result.success).toBe(true);
		const cols = (result.data as Record<string, unknown>)['columns'] as string[];
		expect(Array.isArray(cols)).toBe(true);
		expect(cols).toContain('order_id');
	}, 60_000);

	it('get_scope_columns resolves aliases in customers.sql with describe fallback', async () => {
		// customers.sql has CTEs referencing stg_customers and stg_orders which
		// have no YAML columns — describe_table must be called first to populate
		// schema_mapping, then get_scope_columns can resolve the aliases.

		// Step 1: describe both upstream refs
		const descCustomers = await bridge.invokeRaw({ describe_table: true, name: 'stg_customers' });
		const descOrders = await bridge.invokeRaw({ describe_table: true, name: 'stg_orders' });

		const customerCols = ((descCustomers.data as Record<string, unknown>)['columns'] as string[]) ?? [];
		const orderCols = ((descOrders.data as Record<string, unknown>)['columns'] as string[]) ?? [];

		// Step 2: inject into schema_mapping under __described__
		const schemaMapping: Record<string, Record<string, Record<string, Record<string, unknown>>>> = {
			'__described__': {
				'__described__': {
					'stg_customers': Object.fromEntries(customerCols.map(c => [c, {}])),
					'stg_orders': Object.fromEntries(orderCols.map(c => [c, {}])),
				},
			},
		};

		// Step 3: call get_scope_columns with the jaffle customers.sql (Jinja stripped to plain SQL)
		const sql = `
with customers as (
    select * from main.stg_customers
),
orders as (
    select * from main.stg_orders
),
customer_orders as (
    select
        customer_id,
        min(order_date) as first_order_date,
        max(order_date) as most_recent_order_date,
        count(order_id) as number_of_orders
    from orders
    group by customer_id
),
final as (
    select
        customers.customer_id,
        customers.first_name,
        customers.last_name,
        customer_orders.first_order_date,
        customer_orders.most_recent_order_date,
        customer_orders.number_of_orders
    from customers
    left join customer_orders on customers.customer_id = customer_orders.customer_id
)
select * from final
`;

		const result = await bridge.invokeRaw({
			get_scope_columns: true,
			sql,
			dialect: 'duckdb',
			schema_mapping: schemaMapping,
		});

		expect(result.success).toBe(true);
		const aliases = (result.data as Record<string, unknown>)['aliases'] as Record<string, string[]>;
		expect(aliases).toBeDefined();
		expect(aliases['customers']).toContain('customer_id');
		expect(aliases['customers']).toContain('first_name');
	}, 60_000);
});
