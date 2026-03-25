/**
 * Bridge integration tests — spawns a real bridge.py process against the
 * jaffle_shop fixture and exercises the describe_table and get_scope_columns
 * handlers end-to-end.
 *
 * These tests require dbt to be installed in the Python environment detected
 * for this repo. They will fail loudly if the environment is not set up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { BridgeRunner } from '../dbt/bridge-runner';
import { detectPythonEnvironment, type PythonEnvironment } from '../dbt/env-detector';
import { createMockLogger } from './helpers';

const JAFFLE_SHOP = path.join(__dirname, '..', '..', 'samples', 'jaffle_shop');
const BRIDGE_PY = path.join(__dirname, '..', '..', 'resources', 'bridge', 'bridge.py');

/**
 * Derive the dbt command array from the detected Python environment.
 * Mirrors env-detector logic: replace the trailing python/python3/python.exe
 * element with dbt, so uv/poetry/pipenv/conda wrappers are preserved.
 */
function getDbtCommand(env: PythonEnvironment): string[] {
	const cmd = [...env.command];
	const last = cmd[cmd.length - 1];
	if (path.isAbsolute(last)) {
		// Absolute python path — dbt sits alongside it in the same Scripts/bin dir
		const dir = path.dirname(last);
		const dbt = process.platform === 'win32' ? path.join(dir, 'dbt.exe') : path.join(dir, 'dbt');
		return [dbt];
	}
	// Wrapper command (uv run python, poetry run python, …) — swap the last element
	cmd[cmd.length - 1] = 'dbt';
	return cmd;
}

/**
 * Run a dbt command synchronously using the project's detected Python environment.
 * Throws if the command fails so beforeAll surfaces a clear error rather than
 * letting tests fail with opaque assertion messages.
 */
function runDbt(dbtCmd: string[], args: string[]): void {
	const [bin, ...prefix] = dbtCmd;
	const common = ['--project-dir', JAFFLE_SHOP, '--profiles-dir', JAFFLE_SHOP];
	const result = spawnSync(bin, [...prefix, ...args, ...common], { encoding: 'utf-8', timeout: 120_000, cwd: JAFFLE_SHOP });
	if (result.error) {
		throw new Error(`dbt ${args.join(' ')} spawn failed: ${result.error.message}\nbin=${bin}`);
	}
	if (result.status !== 0) {
		throw new Error(`dbt ${args.join(' ')} exited ${result.status}\nstderr: ${result.stderr}\nstdout: ${result.stdout}`);
	}
}

describe('bridge integration', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		const dbt = getDbtCommand(env);
		// Seed source tables (raw_customers, raw_orders) then materialize only the
		// staging models that these tests exercise. This is the minimum setup needed
		// for describe_table to work — no full dbt build required.
		runDbt(dbt, ['seed']);
		runDbt(dbt, ['run', '--select', 'stg_customers', 'stg_orders']);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
	}, 180_000);

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
