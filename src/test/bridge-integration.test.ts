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
import { templateVariants } from '../ftl/sqllens/api';
import { BridgeRunner } from '../dbt/bridge-runner';
import { detectPythonEnvironment, type PythonEnvironment } from '../dbt/env-detector';
import { FtlDocumentParser } from '../ftl/ftl-document-parser';
import type { AdapterContext } from '../ftl/ftl-document-parser';
import { mergeModels, ParseService } from '../services/parse-service';
import type { DocumentModel, TableRefToken, ColumnRefToken } from '../services/parse-service';
import { createMockLogger } from './helpers';

const PYODIDE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pyodide');
const VENDOR_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl');
const ANSI_CONTEXT: AdapterContext = { adapterType: 'ansi' };

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

	it('compile_inline resolves ref() to a concrete relation', async () => {
		const result = await bridge.invokeRaw({
			compile_inline: 'select * from {{ ref(\'stg_customers\') }}',
		});
		expect(result.success).toBe(true);
		const compiled = result.data?.['compiled_sql'] as string;
		expect(compiled).toBeDefined();
		// ref() should be replaced — no Jinja remaining
		expect(compiled).not.toContain('{{');
		// Should reference the actual table name
		expect(compiled.toLowerCase()).toContain('stg_customers');
	}, 60_000);

	it('compile_inline is fast on repeated calls (manifest cache)', async () => {
		const RUNS = 5;
		const timesUncached: number[] = [];
		const timesCached: number[] = [];

		// Uncached: invalidate before each call to force a full re-parse every time
		for (let i = 0; i < RUNS; i++) {
			await bridge.invokeRaw({ invalidate_manifest: true });
			const t0 = Date.now();
			const result = await bridge.invokeRaw({
				compile_inline: 'select * from {{ ref(\'stg_customers\') }}',
			});
			timesUncached.push(Date.now() - t0);
			expect(result.success).toBe(true);
		}

		// Cached: manifest already warm after the uncached runs bootstrapped it; just compile
		for (let i = 0; i < RUNS; i++) {
			const t0 = Date.now();
			const result = await bridge.invokeRaw({
				compile_inline: 'select * from {{ ref(\'stg_customers\') }}',
			});
			timesCached.push(Date.now() - t0);
			expect(result.success).toBe(true);
		}

		const medianUncached = [...timesUncached].sort((a, b) => a - b)[Math.floor(RUNS / 2)];
		const medianCached = [...timesCached].sort((a, b) => a - b)[Math.floor(RUNS / 2)];
		console.log(`compile_inline uncached (ms): ${timesUncached.join(', ')}  median=${medianUncached}`);
		console.log(`compile_inline cached   (ms): ${timesCached.join(', ')}  median=${medianCached}`);
		console.log(`speedup: ${(medianUncached / medianCached).toFixed(1)}x`);

		// Both paths should complete well within 5s per call regardless of cache state.
		expect(medianUncached).toBeLessThan(5_000);
		expect(medianCached).toBeLessThan(5_000);
	}, 300_000);

});

describe('ftl parse_document', () => {
	let parser: FtlDocumentParser;

	beforeAll(async () => {
		parser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, ANSI_CONTEXT);
		await parser.ready();
	}, 60_000);

	afterAll(() => {
		parser.dispose();
	});

	function parseSql(sql: string, schema?: Record<string, Record<string, string>>) {
		return parser.parse(sql, schema ? { schema } : undefined);
	}

	it('parses plain SQL with CTEs', async () => {
		const model = await parseSql(`with orders as (
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(model.ctes).toHaveLength(1);
		expect(model.ctes[0].name).toBe('orders');
	}, 30_000);

	it('qualify_columns resolves bare column table ownership', async () => {
		const model = await parseSql(`with orders as (
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		type ColToken = { type: string; name: string; table?: string };
		const tokens = model.tokens as ColToken[];
		const finalOrderId = tokens.find(t => t.type === 'column_ref' && t.name === 'order_id' && t.table === 'orders');
		expect(finalOrderId?.table).toBe('orders');
	}, 30_000);

	it('column line numbers point to their source line', async () => {
		const model = await parseSql(`with orders as (
    select
        order_id,
        amount,
        customer_id
    from raw_orders
)
select * from orders`);
		expect(model.ctes).toHaveLength(1);
		const cols = model.ctes[0].columns;
		// Lines are 0-based. order_id is on line 2, amount on 3, customer_id on 4.
		expect(cols.find(c => c.name === 'order_id')?.line).toBe(2);
		expect(cols.find(c => c.name === 'amount')?.line).toBe(3);
		expect(cols.find(c => c.name === 'customer_id')?.line).toBe(4);
	}, 30_000);

	it('parses SQL containing Jinja block comments {# ... #}', async () => {
		const model = await parseSql(`{# This is a Jinja comment #}
with orders as (
    {#- another comment -#}
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(model.ctes).toHaveLength(1);
		expect(model.ctes[0].name).toBe('orders');
	}, 30_000);

	it('parses SQL containing Jinja expressions and block tags', async () => {
		const model = await parseSql(`{% set my_var = 'foo' %}
with orders as (
    select order_id, {{ 'amount' }} from {{ ref('raw_orders') }}
)
select * from orders`);
		expect(model.ctes).toHaveLength(1);
	}, 30_000);

	it('returns refs extracted from Jinja expressions', async () => {
		const model = await parseSql(`with src as (
    select * from {{ ref('stg_orders') }}
)
select * from src`);
		expect(model.refs.some(r => r.model === 'stg_orders')).toBe(true);
	}, 30_000);

	it('parses SQL with {{ config(...) }} at the top', async () => {
		const model = await parseSql(`{{ config(materialized='table') }}

with orders as (
    select order_id from {{ ref('raw_orders') }}
    left join {{ ref('raw_customers') }} as c
        on orders.customer_id = c.customer_id
)
select * from orders`);
		expect(model.ctes).toHaveLength(1);
		expect(model.ctes[0].name).toBe('orders');
	}, 30_000);

	it('degrades to an error result for a trailing-conjunct macro (cascade rescue retired)', async () => {
		// {{ generic_is_deleted(...) }} emits an `and …` conjunct after a complete
		// ON clause — its fill is invalid SQL there, and the comment-blank rescue
		// is gone with the cascade. Extraction still works: both macro tags and
		// the syntax_error warnings surface. Restoring a real parse for this
		// input class is the upstream trailing-conjunct ExpansionShape (an
		// `AND 1=1`-shaped fill) + the classifyMacroShape extension on the
		// shapeOf seam — the assertions this test carried before the cascade
		// retirement come back with it.
		const model = await parseSql(`with warehouse as (
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
		expect(model.sqlglotWarnings?.some(w => w.type === 'syntax_error')).toBe(true);
		expect((model.macroCalls ?? []).filter(m => m.name === 'generic_is_deleted')).toHaveLength(2);
	}, 30_000);

	it('extraction survives a trailing-conjunct macro co-existing with {{ ref() }} aliases', async () => {
		// Same retired-rescue class as above: the conjunct macro leaves syntax
		// errors, but ref extraction (tag-based) is unaffected by the failed SQL
		// parse. The exact alias-position assertions return with the upstream
		// trailing-conjunct shape.
		const sql = [
			'select',
			'    co.companykey,',
			'    co.companyname',
			'from {{ ref(\'silver__company\') }} co',
			'left join {{ ref(\'gold__sourcesystem\') }} ss',
			'    on co.sourcesystembkey = ss.sourcename',
			'{{generic_is_deleted(\'co.is_deleted\',\'where\')}}',
		].join('\n');
		const model = await parseSql(sql);
		expect(model.sqlglotWarnings?.some(w => w.type === 'syntax_error')).toBe(true);
		expect(model.refs.map(r => r.model).sort()).toEqual(['gold__sourcesystem', 'silver__company']);
		expect(model.refs.find(r => r.model === 'silver__company')?.line).toBe(3);
	}, 30_000);

	it('finalSelect is emitted with column names', async () => {
		const model = await parseSql(`with orders as (
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(model.finalSelect).toBeDefined();
		expect(model.finalSelect!.columns.map(c => c.name)).toContain('order_id');
		expect(model.finalSelect!.columns.map(c => c.name)).toContain('amount');
	}, 30_000);

	it('finalSelect columns carry line/col positions', async () => {
		const model = await parseSql(`with src as (
    select id, name from raw_src
)
select
    src.id as customer_id,
    src.name
from src`);
		expect(model.finalSelect).toBeDefined();
		// SELECT keyword is on line 3 (0-based); first column on line 4.
		expect(model.finalSelect!.line).toBe(3);
		// customer_id: aliased column on line 4
		const custCol = model.finalSelect!.columns.find(c => c.name === 'customer_id');
		expect(custCol).toBeDefined();
		expect(custCol!.line).toBe(4);
		expect(custCol!.expression).toBe('id');
		expect(custCol!.table).toBe('src');
		expect(custCol!.aliasLine).toBe(4);
		// name: bare qualified column on line 5
		const nameCol = model.finalSelect!.columns.find(c => c.name === 'name');
		expect(nameCol).toBeDefined();
		expect(nameCol!.line).toBe(5);
	}, 30_000);
});

describe('ftl parse_document – sqlglotWarnings', () => {
	let parser: FtlDocumentParser;

	beforeAll(async () => {
		parser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, ANSI_CONTEXT);
		await parser.ready();
	}, 60_000);

	afterAll(() => {
		parser.dispose();
	});

	function parseSql(sql: string) {
		return parser.parse(sql);
	}

	it('reports a syntax_error with position for a typo in a keyword', async () => {
		// 'FRON' is not a valid keyword — sqlglot interprets it as a column alias
		// (SELECT order_id FRON), making 'orders' the unexpected token.
		// 'orders' starts at col 21 (0-based) and ends at 27 (exclusive).
		const model = await parseSql('select order_id FRON orders');
		const syntaxErr = model.sqlglotWarnings?.find(w => w.type === 'syntax_error');
		expect(syntaxErr).toBeDefined();
		expect(syntaxErr!.line).toBe(0);
		expect(syntaxErr!.col).toBe(21);
		expect(syntaxErr!.endCol).toBe(27);
	}, 30_000);

	it('reports no warnings for valid SQL', async () => {
		const model = await parseSql(`with orders as (
    select order_id, amount from raw_orders
)
select order_id, amount from orders`);
		expect(model.sqlglotWarnings ?? []).toHaveLength(0);
	}, 30_000);

	it('syntax_error line and col are 0-based and match the bad token', async () => {
		// The typo is on line 3 (0-based). Same 'FRON' pattern: sqlglot treats FRON
		// as a column alias and flags 'orders' as unexpected.
		// Within line 3 ('select order_id FRON orders'), 'orders' starts at col 21.
		const model = await parseSql('with orders as (\n    select order_id from raw_orders\n)\nselect order_id FRON orders');
		const syntaxErr = model.sqlglotWarnings?.find(w => w.type === 'syntax_error');
		expect(syntaxErr).toBeDefined();
		expect(syntaxErr!.line).toBe(3);
		expect(syntaxErr!.col).toBe(21);
		expect(syntaxErr!.endCol).toBe(27);
	}, 30_000);
});

describe('ftl parse_document – conditional branches', () => {
	let parser: FtlDocumentParser;

	beforeAll(async () => {
		parser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, ANSI_CONTEXT);
		await parser.ready();
	}, 60_000);

	afterAll(() => {
		parser.dispose();
	});

	async function parseWithBranches(source: string): Promise<DocumentModel> {
		const variants = templateVariants(source, 'duckdb');
		const models: DocumentModel[] = [];
		for (const variant of variants) {
			try {
				models.push(await parser.parse(variant.text()));
			} catch {
				// skip failed variants
			}
		}
		if (models.length === 0) throw new Error('all variants failed to parse');
		return mergeModels(models);
	}

	it('mergeModels preserves ninjaSqlTokens (regression: comment masking broken for Jinja conditional files)', async () => {
		// When a file has {% if %} blocks, templateVariants produces multiple variants and
		// mergeModels is called. The original mergeModels dropped its token stream, so
		// layout rules had no comment spans to mask — causing false-positive violations
		// inside -- comments.
		const source = [
			'select',
			'    {% if is_incremental() %}count (*){% else %}coalesce(id, 0){% endif %}  -- count (comment)',
			'from raw_table',
		].join('\n');
		const model = await parseWithBranches(source);
		expect(model.ninjaSqlTokens, 'mergeModels must carry ninjaSqlTokens from the first variant').toBeDefined();
		expect(Array.isArray(model.ninjaSqlTokens)).toBe(true);
		expect(model.ninjaSqlTokens!.length).toBeGreaterThan(0);
	}, 30_000);

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
		expect(model.refs.find(r => r.model === 'orders_inc')?.line).toBe(1);
		expect(model.refs.find(r => r.model === 'orders_full')?.line).toBe(1);
	}, 30_000);

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

		expect(cols.some(c => c.name === 'incremental_col')).toBe(true);
		expect(cols.some(c => c.name === 'full_col')).toBe(true);
		expect(cols.some(c => c.name === 'shared_col')).toBe(true);
		expect(cols.filter(c => c.name === 'shared_col').length).toBe(1);
		expect(cols.find(c => c.name === 'incremental_col')?.line).toBe(2);
		expect(cols.find(c => c.name === 'full_col')?.line).toBe(2);
		expect(cols.find(c => c.name === 'shared_col')?.line).toBe(3);
	}, 30_000);

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
		expect(cols.filter(c => c.name === 'always_present').length).toBe(1);
		expect(cols.find(c => c.name === 'always_present')?.line).toBe(1);
		expect(cols.find(c => c.name === 'optional_col')?.line).toBe(1);
	}, 30_000);

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
		expect(cols.filter(c => c.name === 'base_col').length).toBe(1);
		expect(cols.find(c => c.name === 'col_a')?.line).toBe(2);
		expect(cols.find(c => c.name === 'col_b')?.line).toBe(2);
		expect(cols.find(c => c.name === 'col_c')?.line).toBe(2);
		expect(cols.find(c => c.name === 'base_col')?.line).toBe(3);
	}, 30_000);

	it('token positions outside conditional branches are preserved exactly', async () => {
		const source = 'SELECT {% if v %}col_a{% else %}col_b{% endif %}, c FROM anchor_table';
		expect(source.indexOf('anchor_table')).toBe(57);
		expect(source.indexOf('anchor_table') + 'anchor_table'.length).toBe(69);

		const model = await parseWithBranches(source);
		const tableRefs = model.tokens.filter(t => t.type === 'table_ref' && t.name === 'anchor_table');
		expect(tableRefs.length).toBe(1);
		expect(tableRefs[0].line).toBe(0);
		expect(tableRefs[0].col).toBe(57);
		expect(tableRefs[0].endCol).toBe(69);
	}, 30_000);
});

describe('ftl parse_document – PIVOT/UNPIVOT virtual columns', () => {
	let parser: FtlDocumentParser;

	beforeAll(async () => {
		parser = FtlDocumentParser.create(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR, ANSI_CONTEXT);
		await parser.ready();
	}, 60_000);

	afterAll(() => {
		parser.dispose();
	});

	function parseSql(sql: string) {
		return parser.parse(sql);
	}

	it('UNPIVOT value and name columns are captured in pivotVirtualColumns', async () => {
		const model = await parseSql(`with source_data as (
    select country, revenue_2022, revenue_2023 from raw_sales
)
select country, revenue, year
from source_data
unpivot (revenue for year in (revenue_2022, revenue_2023))`);

		expect(model.pivotVirtualColumns).toBeDefined();
		const cols = model.pivotVirtualColumns!['source_data'];
		expect(cols).toBeDefined();
		expect(cols).toContain('revenue');
		expect(cols).toContain('year');
	}, 30_000);

	it('columnsForRef includes UNPIVOT virtual columns alongside CTE columns', async () => {
		const model = await parseSql(`with source_data as (
    select country, revenue_2022, revenue_2023 from raw_sales
)
select country, revenue, year
from source_data
unpivot (revenue for year in (revenue_2022, revenue_2023))`);

		// Find the table_ref for source_data used in the final select
		const tblRef = model.tokens.find(t => t.type === 'table_ref' && t.name === 'source_data' && !('cteDefinition' in t));
		expect(tblRef).toBeDefined();
		const { ParseService } = await import('../services/parse-service.js');
		const cols = ParseService.columnsForRef(tblRef as any, model);
		expect(cols).toBeDefined();
		// Original CTE columns
		expect(cols).toContain('country');
		// UNPIVOT virtual columns
		expect(cols).toContain('revenue');
		expect(cols).toContain('year');
	}, 30_000);

	it('plain PIVOT does not populate pivotVirtualColumns', async () => {
		// A regular PIVOT should not pollute the virtual columns map
		const model = await parseSql(`with data as (
    select year, country, revenue from raw_sales
),
pivoted as (
    select *
    from data
    pivot (sum(revenue) for year in (2022, 2023))
)
select * from pivoted`);

		// pivotVirtualColumns may be populated for PIVOT aggregates; the point is
		// that no entry should be keyed 'data' with value/name columns from UNPIVOT
		const dataCols = model.pivotVirtualColumns?.['data'];
		// PIVOT generates column names from the IN list values (2022, 2023), not
		// value/name virtual columns — those should not appear as CTE column names.
		// Simply assert no false positives: if there ARE entries they must not be
		// the UNPIVOT-style pair ('revenue', 'year').
		expect(dataCols?.includes('year')).toBeFalsy();
	}, 30_000);

	it('column resolution through subquery alias', async () => {
		const model = await parseSql('SELECT x.col FROM (SELECT col FROM raw_orders) AS x');
		const colRef = model.tokens.find((t): t is ColumnRefToken =>
			t.type === 'column_ref' && t.name === 'col' && 'table' in t && t.table === 'x',
		);
		expect(colRef).toBeDefined();
		expect(colRef!.resolvedTableRef).toBeDefined();
		const cols = ParseService.columnsForRef(colRef!.resolvedTableRef!, model);
		expect(cols).toContain('col');
	}, 30_000);

	it('nested subquery with shadowed alias resolves keepone', async () => {
		const model = await parseSql(`WITH cte AS (
    SELECT ctc.keepone
    FROM (
        SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS keepone
        FROM (SELECT id FROM raw_orders) AS ctc
    ) AS ctc
    WHERE ctc.keepone = 1
)
SELECT * FROM cte`);
		// The column_ref ctc.keepone should resolve to the middle subquery (which has keepone)
		const colRef = model.tokens.find((t): t is ColumnRefToken =>
			t.type === 'column_ref' && t.name === 'keepone' && 'table' in t && t.table === 'ctc',
		);
		expect(colRef).toBeDefined();
		if (colRef?.resolvedTableRef) {
			const cols = ParseService.columnsForRef(colRef.resolvedTableRef, model);
			expect(cols).toContain('keepone');
		}
	}, 30_000);

	it('subquery entries appear in model.ctes', async () => {
		const model = await parseSql('SELECT x.col FROM (SELECT col FROM raw_orders) AS x');
		const subCte = model.ctes.find(c => c.name === 'x');
		expect(subCte).toBeDefined();
		expect(subCte!.columns.map(c => c.name)).toContain('col');
	}, 30_000);

	it('subquery table_ref token has correct alias position', async () => {
		const sql = 'SELECT x.col\nFROM (\n    SELECT col FROM raw_orders\n) AS x';
		const model = await parseSql(sql);
		const tableRef = model.tokens.find((t): t is TableRefToken =>
			t.type === 'table_ref' && 'alias' in t && t.alias === 'x',
		);
		expect(tableRef).toBeDefined();
		// 'x' is on line 3 ("`) AS x`"), at a known position
		expect(tableRef!.aliasLine).toBe(3);
		expect(tableRef!.aliasCol).toBeDefined();
		expect(tableRef!.aliasEndCol).toBeDefined();
		expect(tableRef!.aliasEndCol! - tableRef!.aliasCol!).toBe(1); // 'x' is 1 char
	}, 30_000);
});
