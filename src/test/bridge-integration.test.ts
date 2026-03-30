/**
 * Bridge integration tests — spawns a real bridge.py process against the
 * jaffle_shop fixture and exercises the describe_table and parse_document
 * handlers end-to-end.
 *
 * These tests require dbt to be installed in the Python environment detected
 * for this repo. They will fail loudly if the environment is not set up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import { generateVariants } from '../dbt/sql-variant-generator';
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

		// Check whether the staging tables already exist in the DuckDB file.
		// If they do, skip the expensive seed+run step so repeated test runs are fast.
		const dbPath = path.join(JAFFLE_SHOP, 'jaffle_shop.duckdb');
		const checkScript = [
			'import duckdb, sys',
			`con = duckdb.connect(${JSON.stringify(dbPath)}, read_only=True)`,
			'tables = {r[0] for r in con.execute("SHOW TABLES").fetchall()}',
			'sys.exit(0 if {"stg_customers","stg_orders"}.issubset(tables) else 1)',
		].join('; ');
		const [bin, ...args] = env.command;
		const check = spawnSync(bin, [...args, '-c', checkScript], { encoding: 'utf-8', timeout: 10_000 });
		const needsSetup = check.status !== 0;

		if (needsSetup) {
			// Seed source tables (raw_customers, raw_orders) then materialize only the
			// staging models that these tests exercise. This is the minimum setup needed
			// for describe_table to work — no full dbt build required.
			runDbt(dbt, ['seed']);
			runDbt(dbt, ['run', '--select', 'stg_customers', 'stg_orders']);
		}

		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
		// Warm up the bridge process so the first test doesn't pay Python startup cost.
		await bridge.invokeRaw({ parse_document: true, sql: 'select 1 as id', dialect: 'ansi' });
	}, 180_000);

	afterAll(async () => {
		await bridge.shutdown();
	});

	it.skip('describe_table returns columns for stg_customers', async () => {
		const result = await bridge.invokeRaw({ describe_table: true, name: 'stg_customers' });
		expect(result.success).toBe(true);
		const cols = (result.data as Record<string, unknown>)['columns'] as string[];
		expect(Array.isArray(cols)).toBe(true);
		expect(cols.length).toBeGreaterThan(0);
		expect(cols).toContain('customer_id');
	}, 60_000);

	it.skip('parse_document with schema_mapping resolves aliases in customers.sql', async () => {
		// customers.sql has CTEs referencing stg_customers and stg_orders which
		// have no YAML columns — describe_table must be called first to populate
		// schema_mapping, then parse_document can resolve the aliases in a single call.

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

		// Step 3: parse_document with schema_mapping — aliases resolved in one call
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
			parse_document: true,
			sql,
			dialect: 'duckdb',
			schema_mapping: schemaMapping,
		});

		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const aliases = data['aliases'] as Record<string, string[]>;
		expect(aliases).toBeDefined();
		expect(aliases['customers']).toContain('customer_id');
		expect(aliases['customers']).toContain('first_name');
	}, 60_000);
});

describe('bridge parse_document', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		// Use the same JAFFLE_SHOP path so detectPythonEnvironment finds the
		// .venv that has dbt — parse_document itself doesn't need dbt but the
		// bridge needs a Python env that at minimum has sqlglot available.
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
	}, 30_000);

	afterAll(async () => {
		await bridge.shutdown();
	});

	function parseSql(sql: string) {
		return bridge.invokeRaw({ parse_document: true, sql, dialect: 'ansi' });
	}

	it('parses plain SQL with CTEs', async () => {
		const result = await parseSql(`with orders as (
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const ctes = data['ctes'] as Array<Record<string, unknown>>;
		expect(ctes).toHaveLength(1);
		expect(ctes[0]['name']).toBe('orders');
	}, 30_000);

	it('qualify_columns resolves bare column table ownership', async () => {
		// `select order_id from orders` — bare column with no qualifier.
		// After qualify_columns, sqlglot should resolve `order_id` → table: 'orders'.
		const result = await parseSql(`with orders as (
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		type ColToken = { type: string; name: string; table?: string };
		const tokens = data['tokens'] as ColToken[];
		const finalOrderId = tokens.find(t => t.type === 'column_ref' && t.name === 'order_id' && t.table === 'orders');
		expect(finalOrderId?.table).toBe('orders');
	}, 30_000);

	it('column line numbers point to their source line', async () => {
		// Regression: proj.meta was always empty; must drill into the inner
		// Identifier node to get the actual line number.
		const result = await parseSql(`with orders as (
    select
        order_id,
        amount,
        customer_id
    from raw_orders
)
select * from orders`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const ctes = data['ctes'] as Array<Record<string, unknown>>;
		expect(ctes).toHaveLength(1);
		const cols = ctes[0]['columns'] as Array<{ name: string; line: number }>;
		// Lines are 0-based. order_id is on line 2, amount on 3, customer_id on 4.
		expect(cols.find(c => c.name === 'order_id')?.line).toBe(2);
		expect(cols.find(c => c.name === 'amount')?.line).toBe(3);
		expect(cols.find(c => c.name === 'customer_id')?.line).toBe(4);
	}, 30_000);

	it('parses SQL containing Jinja block comments {# ... #}', async () => {
		// Regression: _blank_jinja did not handle {# #} — sqlglot would fail to parse
		// the literal text "{#" and return success: false.
		const result = await parseSql(`{# This is a Jinja comment #}
with orders as (
    {#- another comment -#}
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const ctes = data['ctes'] as Array<Record<string, unknown>>;
		expect(ctes).toHaveLength(1);
		expect(ctes[0]['name']).toBe('orders');
	}, 30_000);

	it('parses SQL containing Jinja expressions and block tags', async () => {
		const result = await parseSql(`{% set my_var = 'foo' %}
with orders as (
    select order_id, {{ 'amount' }} from {{ ref('raw_orders') }}
)
select * from orders`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const ctes = data['ctes'] as Array<Record<string, unknown>>;
		expect(ctes).toHaveLength(1);
	}, 30_000);

	it('returns refs extracted from Jinja expressions', async () => {
		const result = await parseSql(`with src as (
    select * from {{ ref('stg_orders') }}
)
select * from src`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const refs = data['refs'] as Array<Record<string, unknown>>;
		expect(refs.some(r => r['model'] === 'stg_orders')).toBe(true);
	}, 30_000);

	it('parses SQL with {{ config(...) }} at the top', async () => {
		// Regression: {{ config() }} is in _STATEMENT_MACROS so identifier=None,
		// but the old code fell through to the _ fallback instead of blanking to
		// spaces — leaving a bare `_` before `with` which sqlglot rejected.
		const result = await parseSql(`{{ config(materialized='table') }}

with orders as (
    select order_id from {{ ref('raw_orders') }}
    left join {{ ref('raw_customers') }} as c
        on orders.customer_id = c.customer_id
)
select * from orders`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const ctes = data['ctes'] as Array<Record<string, unknown>>;
		expect(ctes).toHaveLength(1);
		expect(ctes[0]['name']).toBe('orders');
	}, 30_000);

	it('parses SQL where a dbt macro appears in a statement-level position', async () => {
		// Regression: {{ generic_is_deleted() }} expands to a SQL fragment (e.g.
		// an extra JOIN condition).  After normal _blank_jinja it becomes a bare
		// identifier like "generic_is_deleted" between a JOIN condition and a
		// UNION ALL — an invalid position that makes sqlglot raise.
		// The retry path (jinja2 stub rendering + ErrorLevel.IGNORE) must recover.
		const result = await parseSql(`with warehouse as (
    select
        wh.mkey,
        ss.sourcename
    from gold__warehouse wh
    left join gold__sourcesystem ss
        on ss.sourcename = wh.sourcesystembkey
    {{ generic_is_deleted(wh.is_deleted) }}
    union all
    select
        wh2.mkey,
        ss2.sourcename
    from gold__warehouse2 wh2
    left join gold__sourcesystem ss2
        on ss2.sourcename = wh2.sourcesystembkey
    {{ generic_is_deleted(wh2.is_deleted) }}
)
select mkey, sourcename from warehouse`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const ctes = data['ctes'] as Array<Record<string, unknown>>;
		expect(ctes).toHaveLength(1);
		expect(ctes[0]['name']).toBe('warehouse');
		// Line numbers must be reported in raw-SQL coordinates (not rendered coordinates).
		// For this SQL there are no multi-line or dropped Jinja blocks, so the
		// line_map is identity — raw and rendered lines match exactly.
		// 'warehouse' CTE name is on line 0 (0-based).
		expect(ctes[0]['line']).toBe(0);
		type ColEntry = { name: string; line: number };
		const cols = ctes[0]['columns'] as ColEntry[];
		// SELECT list: wh.mkey on line 2, ss.sourcename on line 3.
		expect(cols.find(c => c.name === 'mkey')?.line).toBe(2);
		expect(cols.find(c => c.name === 'sourcename')?.line).toBe(3);
	}, 30_000);

	// Line-number accuracy is tested by the 'parses SQL where a dbt macro appears
	// in a statement-level position' test above, which asserts ctes[0]['line'] and
	// per-column line numbers are in raw-SQL coordinates after the jinja2 fallback path.
});

describe('bridge parse_document – sqlglotWarnings', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
	}, 30_000);

	afterAll(async () => {
		await bridge.shutdown();
	});

	type Warning = { type: string; message: string; line?: number; col?: number; endCol?: number; cteName?: string };

	function parseSql(sql: string) {
		return bridge.invokeRaw({ parse_document: true, sql, dialect: 'ansi' });
	}

	it('reports a syntax_error with position for a typo in a keyword', async () => {
		// 'FRON' is not a valid keyword — sqlglot interprets it as a column alias
		// (SELECT order_id FRON), making 'orders' the unexpected token.
		// col 26 is the 0-based start of 'orders'; endCol 32 is its exclusive end.
		const result = await parseSql('select order_id FRON orders');
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const warnings = data['sqlglotWarnings'] as Warning[];
		const syntaxErr = warnings.find(w => w.type === 'syntax_error');
		expect(syntaxErr).toBeDefined();
		expect(syntaxErr!.line).toBe(0);
		expect(syntaxErr!.col).toBe(26);
		expect(syntaxErr!.endCol).toBe(32);
	}, 30_000);

	it('reports no warnings for valid SQL', async () => {
		const result = await parseSql(`with orders as (
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const warnings = data['sqlglotWarnings'] as Warning[];
		expect(warnings).toHaveLength(0);
	}, 30_000);

	it('syntax_error line and col are 0-based and match the bad token', async () => {
		// The typo is on line 3 (0-based). Same 'FRON' pattern: sqlglot treats FRON
		// as a column alias and flags 'orders' as unexpected.
		// Within line 3 ('select order_id FRON orders'), 'orders' is at col 26.
		const result = await parseSql('with orders as (\n    select order_id from raw_orders\n)\nselect order_id FRON orders');
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const warnings = data['sqlglotWarnings'] as Warning[];
		const syntaxErr = warnings.find(w => w.type === 'syntax_error');
		expect(syntaxErr).toBeDefined();
		expect(syntaxErr!.line).toBe(3);
		expect(syntaxErr!.col).toBe(26);
		expect(syntaxErr!.endCol).toBe(32);
	}, 30_000);
});

describe('bridge parse_document – variant pipeline performance', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
		// Warm up: several rounds to pay Python startup cost and let sqlglot's
		// internal caches (grammar, dialect registries) settle before timing starts.
		const warmupSql = 'select id, amount, status from orders where id > 0';
		for (let i = 0; i < 5; i++) {
			await bridge.invokeRaw({ parse_document: true, sql: warmupSql, dialect: 'ansi' });
		}
	}, 30_000);

	afterAll(async () => {
		await bridge.shutdown();
	});

	const BENCH_RUNS = 50;

	async function parseVariants(source: string): Promise<{ variantCount: number; runTotalsMs: number[]; perVariantMs: number[] }> {
		const variants = generateVariants(source);
		// runTotalsMs[i] = wall time for one full sweep through all variants on run i
		const runTotalsMs: number[] = [];
		// perVariantMs collects all individual variant timings across all runs
		const perVariantMs: number[] = [];
		for (let run = 0; run < BENCH_RUNS; run++) {
			const t0 = performance.now();
			for (const v of variants) {
				const vt0 = performance.now();
				await bridge.invokeRaw({ parse_document: true, sql: v.sql, dialect: 'ansi' });
				perVariantMs.push(performance.now() - vt0);
			}
			runTotalsMs.push(performance.now() - t0);
		}
		return { variantCount: variants.length, runTotalsMs, perVariantMs };
	}

	function report(label: string, result: { variantCount: number; runTotalsMs: number[]; perVariantMs: number[] }): void {
		const { variantCount, runTotalsMs, perVariantMs } = result;
		const sortedTotals = runTotalsMs.slice().sort((a, b) => a - b);
		const medianTotal = sortedTotals[Math.floor(sortedTotals.length / 2)].toFixed(0);
		const sortedPer = perVariantMs.slice().sort((a, b) => a - b);
		const min = sortedPer[0].toFixed(1);
		const max = sortedPer[sortedPer.length - 1].toFixed(1);
		const median = sortedPer[Math.floor(sortedPer.length / 2)].toFixed(1);
		console.log(
			['  ' + label,
				'variants=' + variantCount,
				'runs=' + BENCH_RUNS,
				'median-total=' + medianTotal + 'ms',
				'per-variant min/median/max=' + min + '/' + median + '/' + max + 'ms',
			].join('  '),
		);
	}

	it('plain SQL with no conditionals (1 variant)', async () => {
		const source = [
			'with orders as (',
			'  select order_id, amount, customer_id from raw_orders',
			')',
			'select order_id, amount from orders',
		].join('\n');

		const result = await parseVariants(source);
		report('plain SQL', result);
		expect(result.variantCount).toBe(1);
		// median across runs; ~4ms baseline, 3x headroom for slower machines
		const medianPlain = result.runTotalsMs.slice().sort((a, b) => a - b)[Math.floor(result.runTotalsMs.length / 2)];
		expect(medianPlain).toBeLessThan(15);
	}, 30_000);

	it('realistic dbt model with 4 conditionals (24 variants)', async () => {
		const source = [
			'with source AS (',
			'  SELECT * FROM {{ ref(\'raw_orders\') }}',
			'),',
			'renamed AS (',
			'  SELECT',
			'    id,',
			'    {% if target.type == \'bigquery\' %}',
			'    CAST(amount AS NUMERIC)',
			'    {% elif target.type == \'snowflake\' %}',
			'    TRY_CAST(amount AS DECIMAL(18,2))',
			'    {% else %}',
			'    CAST(amount AS DECIMAL)',
			'    {% endif %} AS amount,',
			'    status,',
			'    {% if var(\'include_timestamps\', true) %}',
			'    created_at,',
			'    updated_at,',
			'    {% endif %}',
			'    customer_id',
			'    {% if is_incremental() %}',
			'    , \'incremental\' AS load_type',
			'    {% else %}',
			'    , \'full\' AS load_type',
			'    {% endif %}',
			'  FROM source',
			'  WHERE 1 = 1',
			'    {% if is_incremental() %}',
			'    AND created_at > (SELECT MAX(created_at) FROM {{ this }})',
			'    {% endif %}',
			')',
			'SELECT * FROM renamed',
		].join('\n');

		const result = await parseVariants(source);
		report('dbt-like model', result);
		expect(result.variantCount).toBe(24);
		// median across runs; ~180ms baseline, 3x headroom for slower machines
		const medianDbt = result.runTotalsMs.slice().sort((a, b) => a - b)[Math.floor(result.runTotalsMs.length / 2)];
		expect(medianDbt).toBeLessThan(540);
	}, 120_000);

	it('5 sequential if/else blocks (32 variants)', async () => {
		const lines = ['SELECT'];
		for (let i = 0; i < 5; i++) {
			const comma = i < 4 ? ',' : '';
			lines.push('  {% if condition_' + i + ' %}column_' + i + '_a{% else %}column_' + i + '_b{% endif %}' + comma);
		}
		lines.push('FROM my_table');
		const source = lines.join('\n');

		const result = await parseVariants(source);
		report('5 seq if/else', result);
		expect(result.variantCount).toBe(32);
		// median across runs; ~90ms baseline, 3x headroom for slower machines
		const medianSeq = result.runTotalsMs.slice().sort((a, b) => a - b)[Math.floor(result.runTotalsMs.length / 2)];
		expect(medianSeq).toBeLessThan(270);
	}, 120_000);

	it('plain SQL with explicit schema (qualify path, 1 variant)', async () => {
		const source = [
			'with orders as (',
			'  select * from raw_orders',
			')',
			'select customer_id, amount from orders',
		].join('\n');

		const schema = { raw_orders: { customer_id: 'INT', amount: 'NUMERIC', status: 'TEXT' } };
		const variants = [{ sql: source }];
		const runTotalsMs: number[] = [];
		const perVariantMs: number[] = [];
		for (let run = 0; run < BENCH_RUNS; run++) {
			const t0 = performance.now();
			for (const v of variants) {
				const vt0 = performance.now();
				await bridge.invokeRaw({ parse_document: true, sql: v.sql, dialect: 'ansi', schema });
				perVariantMs.push(performance.now() - vt0);
			}
			runTotalsMs.push(performance.now() - t0);
		}
		const sortedTotals = runTotalsMs.slice().sort((a, b) => a - b);
		const medianTotal = sortedTotals[Math.floor(sortedTotals.length / 2)];
		const sortedPer = perVariantMs.slice().sort((a, b) => a - b);
		console.log(
			['  plain SQL + schema',
				'variants=1',
				'runs=' + BENCH_RUNS,
				'median-total=' + medianTotal.toFixed(0) + 'ms',
				'per-variant min/median/max=' + sortedPer[0].toFixed(1) + '/' + sortedPer[Math.floor(sortedPer.length / 2)].toFixed(1) + '/' + sortedPer[sortedPer.length - 1].toFixed(1) + 'ms',
			].join('  '),
		);
		// Verify qualify path: parse succeeds and outer SELECT columns are resolved
		const result = await bridge.invokeRaw({ parse_document: true, sql: source, dialect: 'ansi', schema });
		expect(result.success).toBe(true);
		const finalColumns = (result.data as Record<string, unknown>)['finalColumns'] as { name: string }[];
		expect(finalColumns.map(c => c.name)).toContain('customer_id');
		expect(finalColumns.map(c => c.name)).toContain('amount');
		expect(medianTotal).toBeLessThan(50);
	}, 120_000);
});

// ----- types mirroring parse-service DocumentModel for bridge response -----
type ColInfo = { name: string; line: number };
type CteEntry = { name: string; line: number; col?: number; endLine: number; endCol?: number; columns: ColInfo[] };
type RefEntry = { model: string; line: number; col: number };
type TokenEntry = { type: string; name: string; line: number; col: number; endCol: number };
type BridgeModel = {
	ctes: CteEntry[];
	refs: RefEntry[];
	tokens: TokenEntry[];
	finalColumns: ColInfo[];
	timing: { parseMs: number; totalMs: number };
};

// Minimal merge matching the logic in parse-service mergeModels.
// Used here to validate the merge contract without going through ParseService.
function mergeForTest(models: BridgeModel[]): BridgeModel {
	if (models.length === 1) return models[0];

	const cteMap = new Map<string, CteEntry>();
	for (const m of models) {
		for (const cte of m.ctes) {
			const ex = cteMap.get(cte.name);
			if (!ex) {
				cteMap.set(cte.name, { ...cte, columns: [...cte.columns] });
			} else {
				const known = new Set(ex.columns.map(c => c.name));
				for (const col of cte.columns) {
					if (!known.has(col.name)) { ex.columns.push(col); known.add(col.name); }
				}
			}
		}
	}

	const refKeys = new Set<string>();
	const refs: RefEntry[] = [];
	for (const m of models) {
		for (const r of m.refs) {
			const k = r.model + ':' + r.line + ':' + r.col;
			if (!refKeys.has(k)) { refKeys.add(k); refs.push(r); }
		}
	}

	const tokKeys = new Set<string>();
	const tokens: TokenEntry[] = [];
	for (const m of models) {
		for (const t of m.tokens) {
			const k = t.type + ':' + t.line + ':' + t.col;
			if (!tokKeys.has(k)) { tokKeys.add(k); tokens.push(t); }
		}
	}

	const finalNames = new Set<string>();
	const finalColumns: ColInfo[] = [];
	for (const m of models) {
		for (const c of m.finalColumns) {
			if (!finalNames.has(c.name)) { finalNames.add(c.name); finalColumns.push(c); }
		}
	}

	const timing = { parseMs: 0, totalMs: 0 };
	return { ctes: [...cteMap.values()], refs, tokens, finalColumns, timing };
}

describe('bridge parse_document – conditional branches', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
		await bridge.invokeRaw({ parse_document: true, sql: 'select 1 as id', dialect: 'ansi' });
	}, 30_000);

	afterAll(async () => {
		await bridge.shutdown();
	});

	async function parseWithBranches(source: string): Promise<BridgeModel> {
		const variants = generateVariants(source);
		const models: BridgeModel[] = [];
		for (const variant of variants) {
			const result = await bridge.invokeRaw({ parse_document: true, sql: variant.sql, dialect: 'ansi' });
			if (result.success && result.data) {
				models.push(result.data as BridgeModel);
			}
		}
		if (models.length === 0) throw new Error('all variants failed to parse');
		return mergeForTest(models);
	}

	// Case 1 — refs from both if/else arms appear in the merged model.
	// SQL has two mutually exclusive {{ ref() }} calls, one per arm.
	// After merging: both model names must be present even though neither
	// single variant contains both.
	it('refs from both if/else arms are captured in the merged model', async () => {
		const source = [
			'with src as (',
			'    select * from {% if is_incremental() %}{{ ref(\'orders_inc\') }}{% else %}{{ ref(\'orders_full\') }}{% endif %}',
			')',
			'select * from src',
		].join('\n');

		const model = await parseWithBranches(source);
		const refModels = model.refs.map(r => r.model);
		expect(refModels).toContain('orders_inc');
		expect(refModels).toContain('orders_full');
		// Both refs are on line 1 (the SELECT line)
		expect(model.refs.find(r => r.model === 'orders_inc')?.line).toBe(1);
		expect(model.refs.find(r => r.model === 'orders_full')?.line).toBe(1);
	}, 30_000);

	// Case 2 — CTE columns from both arms are present at correct source lines,
	// and a column that appears in every variant is not duplicated.
	//
	// Source layout (0-based lines):
	//   0: with data as (
	//   1:     SELECT
	//   2:         {% if is_incremental() %}incremental_col{% else %}full_col{% endif %},
	//   3:         shared_col
	//   4:     FROM raw_table
	//   5: )
	//   6: SELECT * FROM data
	//
	// Variant 1 (if=true):  columns = [incremental_col@2, shared_col@3]
	// Variant 2 (if=false): columns = [full_col@2,        shared_col@3]
	// After merge:           columns = [incremental_col@2, shared_col@3, full_col@2]
	it('CTE columns from both if/else arms are at correct source lines and shared column is not duplicated', async () => {
		const source = [
			'with data as (',
			'    SELECT',
			'        {% if is_incremental() %}incremental_col{% else %}full_col{% endif %},',
			'        shared_col',
			'    FROM raw_table',
			')',
			'SELECT * FROM data',
		].join('\n');

		const model = await parseWithBranches(source);
		const cte = model.ctes.find(c => c.name === 'data');
		expect(cte).toBeDefined();
		const cols = cte!.columns;

		// Both branch arms present
		expect(cols.some(c => c.name === 'incremental_col')).toBe(true);
		expect(cols.some(c => c.name === 'full_col')).toBe(true);
		// Shared column present
		expect(cols.some(c => c.name === 'shared_col')).toBe(true);
		// Shared column not duplicated (appears in every variant but only once in merged)
		expect(cols.filter(c => c.name === 'shared_col').length).toBe(1);
		// Branch columns at line 2 (original source line, offset preserved by generateVariants)
		expect(cols.find(c => c.name === 'incremental_col')?.line).toBe(2);
		expect(cols.find(c => c.name === 'full_col')?.line).toBe(2);
		// Shared column at line 3
		expect(cols.find(c => c.name === 'shared_col')?.line).toBe(3);
	}, 30_000);

	// Case 3 — if-without-else: the synthetic empty-else arm means neither
	// the true-path column nor the shared column are lost.
	//
	// Source layout:
	//   0: with data as (
	//   1:     SELECT always_present{% if condition %}, optional_col{% endif %} FROM raw_table
	//   2: )
	//   3: SELECT * FROM data
	//
	// Variant 1 (if=true):  SELECT always_present, optional_col FROM raw_table
	// Variant 2 (if=false): SELECT always_present                FROM raw_table  (blanked)
	// After merge: both columns present; always_present not duplicated
	it('if-without-else: column in the true arm is captured via the synthetic empty-else variant', async () => {
		const source = [
			'with data as (',
			'    SELECT always_present{% if condition %}, optional_col{% endif %} FROM raw_table',
			')',
			'SELECT * FROM data',
		].join('\n');

		const model = await parseWithBranches(source);
		const cte = model.ctes.find(c => c.name === 'data');
		expect(cte).toBeDefined();
		const cols = cte!.columns;

		expect(cols.some(c => c.name === 'always_present')).toBe(true);
		expect(cols.some(c => c.name === 'optional_col')).toBe(true);
		// always_present appears in both variants but must not be duplicated
		expect(cols.filter(c => c.name === 'always_present').length).toBe(1);
		// Both columns on line 1
		expect(cols.find(c => c.name === 'always_present')?.line).toBe(1);
		expect(cols.find(c => c.name === 'optional_col')?.line).toBe(1);
	}, 30_000);

	// Case 4 — nested conditionals: every distinct leaf path produces a column
	// that must appear in the merged model at its correct source line.
	//
	// Source layout:
	//   0: with data as (
	//   1:     SELECT
	//   2:         {% if outer %}{% if inner %}col_a{% else %}col_b{% endif %}{% else %}col_c{% endif %},
	//   3:         base_col
	//   4:     FROM raw_table
	//   5: )
	//   6: SELECT * FROM data
	//
	// 3 variants: (outer=T,inner=T)→col_a, (outer=T,inner=F)→col_b, (outer=F)→col_c
	// After merge: col_a@2, col_b@2, col_c@2, base_col@3; base_col not duplicated.
	it('nested conditionals: all leaf-path columns appear at correct source lines', async () => {
		const source = [
			'with data as (',
			'    SELECT',
			'        {% if outer %}{% if inner %}col_a{% else %}col_b{% endif %}{% else %}col_c{% endif %},',
			'        base_col',
			'    FROM raw_table',
			')',
			'SELECT * FROM data',
		].join('\n');

		const model = await parseWithBranches(source);
		const cte = model.ctes.find(c => c.name === 'data');
		expect(cte).toBeDefined();
		const cols = cte!.columns;

		expect(cols.some(c => c.name === 'col_a')).toBe(true);
		expect(cols.some(c => c.name === 'col_b')).toBe(true);
		expect(cols.some(c => c.name === 'col_c')).toBe(true);
		expect(cols.some(c => c.name === 'base_col')).toBe(true);
		// base_col comes from every variant — must appear exactly once
		expect(cols.filter(c => c.name === 'base_col').length).toBe(1);
		// All branch columns land on line 2; base_col on line 3
		expect(cols.find(c => c.name === 'col_a')?.line).toBe(2);
		expect(cols.find(c => c.name === 'col_b')?.line).toBe(2);
		expect(cols.find(c => c.name === 'col_c')?.line).toBe(2);
		expect(cols.find(c => c.name === 'base_col')?.line).toBe(3);
	}, 30_000);

	// Case 5 — content outside any branch retains exact token positions.
	// generateVariants is length-preserving so all positions in every variant
	// map to the original source. This test verifies the invariant by checking
	// that a table_ref token outside the conditional is at the exact column
	// we can compute from the raw source string.
	//
	// Source (single line):
	//   SELECT {% if v %}col_a{% else %}col_b{% endif %}, c FROM anchor_table
	//
	// Offset map (0-based col):
	//   0-6   : "SELECT "
	//   7-16  : "{% if v %}"  (10 chars)
	//   17-21 : "col_a"
	//   22-31 : "{% else %}" (10 chars)
	//   32-36 : "col_b"
	//   37-47 : "{% endif %}" (11 chars)
	//   48-49 : ", "
	//   50    : "c"
	//   52-55 : "FROM "
	//   57-68 : "anchor_table"  ← col=57, endCol=69
	it('token positions outside conditional branches are preserved exactly', async () => {
		// Build the source and verify our offset arithmetic against the actual string
		const source = 'SELECT {% if v %}col_a{% else %}col_b{% endif %}, c FROM anchor_table';
		// Sanity-check: anchor_table starts at col 57
		expect(source.indexOf('anchor_table')).toBe(57);
		expect(source.indexOf('anchor_table') + 'anchor_table'.length).toBe(69);

		const model = await parseWithBranches(source);
		const tableRefs = model.tokens.filter(t => t.type === 'table_ref' && t.name === 'anchor_table');
		// anchor_table appears in every variant (it is outside the branch) —
		// after dedup it must appear exactly once
		expect(tableRefs.length).toBe(1);
		expect(tableRefs[0].line).toBe(0);
		expect(tableRefs[0].col).toBe(57);
		expect(tableRefs[0].endCol).toBe(69);
	}, 30_000);
});
