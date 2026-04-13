/**
 * Bridge integration tests for the emit_debug_symbols command.
 *
 * Spawns a real bridge.py process and exercises the symbol table generation
 * end-to-end.  Only requires sqlglot (vendored) — no dbt setup needed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { BridgeRunner, type DbtCommandResult } from '../dbt/bridge-runner';
import { detectPythonEnvironment } from '../dbt/env-detector';
import { emitDebugSymbolsFromTokens, findJinjaSpans, injectMarkers, parseSourceMap, type SymbolEntry } from '../dbt/debug-symbols';
import { initPyodide } from '../ftl/pyodide-loader.js';
import type { PyodideRuntime } from '../ftl/pyodide-loader.js';
import { PyodideSqlParser } from '../ftl/pyodide-sql-parser.js';
import { createMockLogger } from './helpers';

const JAFFLE_SHOP = path.join(__dirname, '..', '..', 'samples', 'jaffle_shop');
const BRIDGE_PY = path.join(__dirname, '..', '..', 'resources', 'bridge', 'bridge.py');

function getSymbols(result: DbtCommandResult): SymbolEntry[] {
	return (result.data as Record<string, unknown>)['symbols'] as SymbolEntry[];
}

describe('emit_debug_symbols bridge integration', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
		// Warm up so first test doesn't pay startup cost
		await bridge.invokeRaw({ emit_debug_symbols: true, sql: 'SELECT 1', dialect: 'ansi' });
	}, 60_000);

	afterAll(async () => {
		await bridge.shutdown();
	});

	it('returns symbols for simple SQL', async () => {
		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql: 'SELECT id, name FROM orders WHERE id > 1',
			dialect: 'duckdb',
		});

		expect(result.success).toBe(true);
		const symbols = getSymbols(result);
		expect(symbols.length).toBeGreaterThan(0);

		// Should contain SELECT, FROM, WHERE clause keywords
		const roles = symbols.map(s => s.role);
		expect(roles).toContain('select');
		expect(roles).toContain('from');
		expect(roles).toContain('where');
		expect(roles).toContain('ident');
	});

	it('returns correct 0-based positions', async () => {
		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql: 'SELECT id FROM t',
			dialect: 'duckdb',
		});

		const symbols = getSymbols(result);
		const selectSym = symbols.find(s => s.role === 'select');
		expect(selectSym).toMatchObject({ line: 0, col: 0, endCol: 6, role: 'select' });

		const idSym = symbols.find(s => s.role === 'ident' && s.col === 7);
		expect(idSym).toMatchObject({ line: 0, col: 7, endCol: 9, role: 'ident' });

		const fromSym = symbols.find(s => s.role === 'from');
		expect(fromSym).toMatchObject({ line: 0, col: 10, endCol: 14, role: 'from' });
	});

	it('handles multiline SQL', async () => {
		const sql = 'SELECT\n  id,\n  name\nFROM\n  orders';
		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql,
			dialect: 'duckdb',
		});

		const symbols = getSymbols(result);
		const selectSym = symbols.find(s => s.role === 'select');
		expect(selectSym!.line).toBe(0);

		const fromSym = symbols.find(s => s.role === 'from');
		expect(fromSym!.line).toBe(3);
	});

	it('handles complex CTE query', async () => {
		const sql = [
			'WITH base AS (',
			'  SELECT id, status FROM raw_orders',
			'),',
			'filtered AS (',
			'  SELECT id FROM base WHERE status = \'completed\'',
			')',
			'SELECT * FROM filtered',
		].join('\n');

		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql,
			dialect: 'duckdb',
		});

		const symbols = getSymbols(result);
		const roles = symbols.map(s => s.role);
		expect(roles).toContain('cte');
		expect(roles).toContain('select');
		expect(roles).toContain('from');
		expect(roles).toContain('where');
		expect(roles).toContain('star');
	});

	it('assigns _main_ frameName for simple queries', async () => {
		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql: 'SELECT id FROM t',
			dialect: 'duckdb',
		});

		const symbols = getSymbols(result);
		for (const sym of symbols) {
			expect(sym.frameName).toBe('_main_');
		}
	});

	it('assigns CTE names as frameName for CTE queries', async () => {
		const sql = [
			'WITH base AS (',
			'  SELECT id, status FROM raw_orders',
			'),',
			'filtered AS (',
			'  SELECT id FROM base WHERE status = \'completed\'',
			')',
			'SELECT * FROM filtered',
		].join('\n');

		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql,
			dialect: 'duckdb',
		});

		const symbols = getSymbols(result);

		// Symbols on line 1 (inside "base" CTE) should have frameName "base"
		const baseLine = symbols.filter(s => s.line === 1);
		expect(baseLine.length).toBeGreaterThan(0);
		for (const sym of baseLine) {
			expect(sym.frameName).toBe('base');
		}

		// Symbols on line 4 (inside "filtered" CTE) should have frameName "filtered"
		const filteredLine = symbols.filter(s => s.line === 4);
		expect(filteredLine.length).toBeGreaterThan(0);
		for (const sym of filteredLine) {
			expect(sym.frameName).toBe('filtered');
		}

		// Symbols on line 6 (final SELECT) should have frameName "_main_"
		const mainLine = symbols.filter(s => s.line === 6);
		expect(mainLine.length).toBeGreaterThan(0);
		for (const sym of mainLine) {
			expect(sym.frameName).toBe('_main_');
		}
	});

	it('filters out blanked Jinja tokens', async () => {
		const sql = 'SELECT id FROM {{ ref(\'orders\') }} WHERE id > 1';
		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql,
			dialect: 'duckdb',
		});

		const symbols = getSymbols(result);
		// Should NOT have a symbol at the Jinja position (col 15-34)
		const jinjaSymbol = symbols.find(s => s.col >= 15 && s.col < 34);
		expect(jinjaSymbol).toBeUndefined();

		// Should still have SELECT, FROM, WHERE
		const roles = symbols.map(s => s.role);
		expect(roles).toContain('select');
		expect(roles).toContain('from');
		expect(roles).toContain('where');
	});

	it('detects function calls', async () => {
		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql: 'SELECT COUNT(id) FROM t',
			dialect: 'duckdb',
		});

		const symbols = getSymbols(result);
		const fnSym = symbols.find(s => s.role === 'fn');
		expect(fnSym).toBeDefined();
		expect(fnSym!.line).toBe(0);
	});

	it('returns empty for empty SQL', async () => {
		const result = await bridge.invokeRaw({
			emit_debug_symbols: true,
			sql: '',
			dialect: 'duckdb',
		});

		expect(result.success).toBe(true);
		const symbols = getSymbols(result);
		expect(symbols).toEqual([]);
	});

	it('roundtrip: single-line SQL, all symbol source lines survive inject→parse', async () => {
		const source = 'SELECT id, name FROM orders WHERE id > 1';
		const result = await bridge.invokeRaw({ emit_debug_symbols: true, sql: source, dialect: 'duckdb' });
		const symbols = getSymbols(result);
		const annotated = injectMarkers(source, symbols, findJinjaSpans(source));
		const sourceMap = parseSourceMap(annotated);

		expect(sourceMap.mappings.length).toBe(symbols.length);
		for (const m of sourceMap.mappings) {
			const orig = symbols.find(s => s.line === m.sourceLine && s.col === m.sourceCol);
			expect(orig, `no symbol for mapping at L${m.sourceLine}:C${m.sourceCol}`).toBeDefined();
			expect(m.role).toBe(orig!.role);
		}
	});

	it('roundtrip: multi-line SQL preserves line numbers through inject→parse', async () => {
		const source = [
			'SELECT',
			'  id,',
			'  name',
			'FROM orders',
			'WHERE id > 1',
		].join('\n');
		const result = await bridge.invokeRaw({ emit_debug_symbols: true, sql: source, dialect: 'duckdb' });
		const symbols = getSymbols(result);
		const annotated = injectMarkers(source, symbols, findJinjaSpans(source));
		const sourceMap = parseSourceMap(annotated);

		// SELECT is on line 0, FROM on line 3, WHERE on line 4
		const selectSym = symbols.find(s => s.role === 'select');
		const fromSym = symbols.find(s => s.role === 'from');
		const whereSym = symbols.find(s => s.role === 'where');
		expect(selectSym!.line).toBe(0);
		expect(fromSym!.line).toBe(3);
		expect(whereSym!.line).toBe(4);

		// After inject+parse, compiled lines should be the same (no Jinja, so 1:1)
		const selectMap = sourceMap.compiledToSource(selectSym!.line);
		const fromMap = sourceMap.compiledToSource(fromSym!.line);
		const whereMap = sourceMap.compiledToSource(whereSym!.line);
		expect(selectMap[0].sourceLine).toBe(0);
		expect(fromMap[0].sourceLine).toBe(3);
		expect(whereMap[0].sourceLine).toBe(4);
	});

	it('roundtrip: CTE query — each CTE keyword maps to its correct source line', async () => {
		const source = [
			'with',
			'base as (',
			'  select id, status from raw_orders',
			'),',
			'filtered as (',
			'  select id from base where status = \'completed\'',
			')',
			'select * from filtered',
		].join('\n');
		const result = await bridge.invokeRaw({ emit_debug_symbols: true, sql: source, dialect: 'duckdb' });
		const symbols = getSymbols(result);
		const annotated = injectMarkers(source, symbols, findJinjaSpans(source));
		const sourceMap = parseSourceMap(annotated);

		// 'with' keyword is on line 0
		const cteMapping = sourceMap.mappings.find(m => m.role === 'cte');
		expect(cteMapping, 'no cte mapping').toBeDefined();
		expect(cteMapping!.sourceLine).toBe(0);

		// 'select' inside base CTE is on line 2; 'select' inside filtered is on line 5; final select on line 7
		const selectMappings = sourceMap.mappings.filter(m => m.role === 'select');
		const selectLines = selectMappings.map(m => m.sourceLine).sort((a, b) => a - b);
		expect(selectLines).toEqual([2, 5, 7]);
	});

	it('roundtrip: Jinja ref() on same line — compiled line equals source line', async () => {
		// Simulates: source has {{ ref('orders') }}, compiled replaces it with table name.
		// Because Jinja is inline (no extra newlines), compiled line count == source line count.
		const source = [
			'with base as (',
			'  select id from {{ ref(\'raw_orders\') }}',
			')',
			'select * from base',
		].join('\n');

		const result = await bridge.invokeRaw({ emit_debug_symbols: true, sql: source, dialect: 'duckdb' });
		const symbols = getSymbols(result);
		const jinjaSpans = findJinjaSpans(source);

		// Jinja token on line 1 should NOT have a symbol (it's blanked)
		const jinjaLineSymbols = symbols.filter(s => s.line === 1 && s.col >= 17);
		expect(jinjaLineSymbols.filter(s => s.col >= 17 && s.col < 38)).toHaveLength(0);

		const annotated = injectMarkers(source, symbols, jinjaSpans);

		// Simulate what dbt compile does: replace {{ ref('raw_orders') }} with a table name.
		// The Jinja is on one line so line count stays the same.
		const compiled = annotated.replace('{{ ref(\'raw_orders\') }}', 'main.raw_orders');
		const sourceMap = parseSourceMap(compiled);

		// from keyword is on source line 1
		const fromSym = symbols.find(s => s.role === 'from');
		expect(fromSym!.line).toBe(1);

		// The source map must map compiled line 1 back to source line 1
		const fromCompiledMappings = sourceMap.compiledToSource(1);
		const fromMapping = fromCompiledMappings.find(m => m.role === 'from');
		expect(fromMapping, 'from mapping on compiled line 1').toBeDefined();
		expect(fromMapping!.sourceLine).toBe(1);
	});

	it('roundtrip: decompose frame lines survive inject→compile→parse→remap cycle', async () => {
		// Full end-to-end for a 2-CTE query without Jinja:
		// emit symbols → inject → "compile" (identity, no Jinja) → parse source map →
		// decompose compiled → check that frame.line matches source CTE line.
		const source = [
			'with',
			'cte_a as (',
			'  select id from raw_a',
			'),',
			'cte_b as (',
			'  select id from raw_b',
			')',
			'select * from cte_b',
		].join('\n');

		const emitResult = await bridge.invokeRaw({ emit_debug_symbols: true, sql: source, dialect: 'duckdb' });
		const symbols = getSymbols(emitResult);
		const annotated = injectMarkers(source, symbols, findJinjaSpans(source));

		// No Jinja → compiled == annotated
		const compiled = annotated;
		const sourceMap = parseSourceMap(compiled);

		const decomposeResult = await bridge.invokeRaw({ decompose_query: true, compiled_sql: compiled, dialect: 'duckdb' });
		expect(decomposeResult.success).toBe(true);
		const frames = (decomposeResult.data as Record<string, unknown>).frames as Array<{ name: string; line: number; endLine: number }>;

		const cteA = frames.find(f => f.name === 'cte_a');
		const cteB = frames.find(f => f.name === 'cte_b');
		expect(cteA, 'cte_a frame').toBeDefined();
		expect(cteB, 'cte_b frame').toBeDefined();

		// Remap: compiledToSource for each frame start line
		const cteASourceMappings = sourceMap.compiledToSource(cteA!.line);
		const cteBSourceMappings = sourceMap.compiledToSource(cteB!.line);

		// cte_a starts on source line 1, cte_b on source line 4
		expect(cteASourceMappings.length).toBeGreaterThan(0);
		expect(cteBSourceMappings.length).toBeGreaterThan(0);
		expect(cteASourceMappings[0].sourceLine).toBe(1);
		expect(cteBSourceMappings[0].sourceLine).toBe(4);
	});

	it('roundtrip: decompose frame lines survive inject→compile(with Jinja)→parse→remap cycle', async () => {
		// Same as above but with {{ ref() }} on the FROM lines.
		// After "compilation" the Jinja is replaced with a table name on the same line.
		// Line count must be preserved and the source map must still remap correctly.
		const source = [
			'with',
			'cte_a as (',
			'  select id from {{ ref(\'raw_a\') }}',
			'),',
			'cte_b as (',
			'  select id from {{ ref(\'raw_b\') }}',
			')',
			'select * from cte_b',
		].join('\n');

		const emitResult = await bridge.invokeRaw({ emit_debug_symbols: true, sql: source, dialect: 'duckdb' });
		const symbols = getSymbols(emitResult);
		const annotated = injectMarkers(source, symbols, findJinjaSpans(source));

		// Simulate dbt compile: replace Jinja with table names (same line count)
		const compiled = annotated
			.replace('{{ ref(\'raw_a\') }}', 'main.raw_a')
			.replace('{{ ref(\'raw_b\') }}', 'main.raw_b');

		const sourceMap = parseSourceMap(compiled);

		const decomposeResult = await bridge.invokeRaw({ decompose_query: true, compiled_sql: compiled, dialect: 'duckdb' });
		expect(decomposeResult.success).toBe(true);
		const frames = (decomposeResult.data as Record<string, unknown>).frames as Array<{ name: string; line: number; endLine: number }>;

		const cteA = frames.find(f => f.name === 'cte_a');
		const cteB = frames.find(f => f.name === 'cte_b');
		expect(cteA, 'cte_a frame').toBeDefined();
		expect(cteB, 'cte_b frame').toBeDefined();

		// Remap compiled frame lines → source lines
		const cteAMappings = sourceMap.compiledToSource(cteA!.line);
		const cteBMappings = sourceMap.compiledToSource(cteB!.line);

		expect(cteAMappings.length, 'cte_a must have a source mapping').toBeGreaterThan(0);
		expect(cteBMappings.length, 'cte_b must have a source mapping').toBeGreaterThan(0);
		expect(cteAMappings[0].sourceLine).toBe(1);
		expect(cteBMappings[0].sourceLine).toBe(4);
	});
});

describe('decompose_query subquery promotion', () => {
	let bridge: BridgeRunner;

	beforeAll(async () => {
		const env = detectPythonEnvironment(JAFFLE_SHOP);
		bridge = new BridgeRunner(BRIDGE_PY, JAFFLE_SHOP, env, createMockLogger());
		await bridge.invokeRaw({ decompose_query: true, compiled_sql: 'SELECT 1', dialect: 'duckdb' });
	}, 60_000);

	afterAll(async () => {
		await bridge.shutdown();
	});

	it('promotes a FROM subquery to a synthetic CTE frame', async () => {
		const sql = [
			'SELECT t.id, t.name',
			'FROM (SELECT id, name FROM raw_customers WHERE active = 1) t',
		].join('\n');

		const result = await bridge.invokeRaw({ decompose_query: true, compiled_sql: sql, dialect: 'duckdb' });
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const frames = data.frames as Array<{ name: string; type: string }>;
		const refs = data.refs as Record<string, string[]>;

		// Synthetic frame promoted from the FROM subquery (alias 't' used as CTE name)
		const syntheticFrame = frames.find(f => f.name === 't');
		expect(syntheticFrame, 'synthetic frame for FROM subquery').toBeDefined();
		expect(syntheticFrame!.type).toBe('cte');

		// _main_ refs should now point to the synthetic CTE 't'
		expect(refs['_main_']).toContain('t');
	});

	it('promotes a JOIN subquery to a synthetic CTE frame', async () => {
		const sql = [
			'WITH base AS (SELECT id FROM raw_orders)',
			'SELECT b.id, w.total',
			'FROM base b',
			'INNER JOIN (SELECT order_id, sum(amount) AS total FROM raw_items GROUP BY ALL) w',
			'  ON b.id = w.order_id',
		].join('\n');

		const result = await bridge.invokeRaw({ decompose_query: true, compiled_sql: sql, dialect: 'duckdb' });
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const frames = data.frames as Array<{ name: string; type: string }>;
		const refs = data.refs as Record<string, string[]>;

		// 'w' is the JOIN subquery alias → becomes a synthetic CTE named 'w'
		const syntheticFrame = frames.find(f => f.name === 'w');
		expect(syntheticFrame, 'synthetic frame for JOIN subquery').toBeDefined();
		expect(syntheticFrame!.type).toBe('cte');

		// _main_ (which sees base and w) should ref both
		expect(refs['_main_']).toContain('w');

		// base CTE should still exist
		expect(frames.find(f => f.name === 'base')).toBeDefined();
	});

	it('handles a subquery with no alias using a generated name', async () => {
		const sql = 'SELECT * FROM (SELECT id FROM raw_customers) AS anon_sub';

		const result = await bridge.invokeRaw({ decompose_query: true, compiled_sql: sql, dialect: 'duckdb' });
		expect(result.success).toBe(true);
		const data = result.data as Record<string, unknown>;
		const frames = data.frames as Array<{ name: string; type: string }>;

		// 'anon_sub' alias used as CTE name
		expect(frames.find(f => f.name === 'anon_sub')).toBeDefined();
	});
});

describe('emitDebugSymbolsFromTokens', () => {
	const PYODIDE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pyodide');
	const VENDOR_DIR = path.join(__dirname, '..', '..', 'resources', 'bridge', 'vendor');
	const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl');

	let runtime: PyodideRuntime;
	let parser: PyodideSqlParser;

	beforeAll(async () => {
		runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
		parser = PyodideSqlParser.create(runtime.pyodide);
	}, 60_000);

	async function emit(sql: string, dialect = 'duckdb') {
		const result = await parser.parse(sql, dialect);
		return emitDebugSymbolsFromTokens(sql, result.sqlTokens ?? [], result.jinjaTags ?? []);
	}

	it('returns symbols for simple SQL', async () => {
		const result = await emit('SELECT id, name FROM orders WHERE id > 1');
		expect(result).toBeDefined();
		const roles = result!.symbols.map(s => s.role);
		expect(roles).toContain('select');
		expect(roles).toContain('from');
		expect(roles).toContain('where');
		expect(roles).toContain('ident');
	});

	it('returns correct 0-based positions', async () => {
		const result = await emit('SELECT id FROM t');
		expect(result).toBeDefined();
		const symbols = result!.symbols;
		const selectSym = symbols.find(s => s.role === 'select');
		expect(selectSym).toMatchObject({ line: 0, col: 0, endCol: 6, role: 'select' });
		const idSym = symbols.find(s => s.role === 'ident' && s.col === 7);
		expect(idSym).toMatchObject({ line: 0, col: 7, endCol: 9, role: 'ident' });
		const fromSym = symbols.find(s => s.role === 'from');
		expect(fromSym).toMatchObject({ line: 0, col: 10, endCol: 14, role: 'from' });
	});

	it('handles multiline SQL', async () => {
		const sql = 'SELECT\n  id,\n  name\nFROM\n  orders';
		const result = await emit(sql);
		expect(result).toBeDefined();
		const selectSym = result!.symbols.find(s => s.role === 'select');
		expect(selectSym!.line).toBe(0);
		const fromSym = result!.symbols.find(s => s.role === 'from');
		expect(fromSym!.line).toBe(3);
	});

	it('handles complex CTE query', async () => {
		const sql = [
			'WITH base AS (',
			'  SELECT id, status FROM raw_orders',
			'),',
			'filtered AS (',
			"  SELECT id FROM base WHERE status = 'completed'",
			')',
			'SELECT * FROM filtered',
		].join('\n');
		const result = await emit(sql);
		expect(result).toBeDefined();
		const roles = result!.symbols.map(s => s.role);
		expect(roles).toContain('cte');
		expect(roles).toContain('select');
		expect(roles).toContain('from');
		expect(roles).toContain('where');
		expect(roles).toContain('star');
	});

	it('assigns _main_ frameName for simple queries', async () => {
		const result = await emit('SELECT id FROM t');
		expect(result).toBeDefined();
		for (const sym of result!.symbols) {
			expect(sym.frameName).toBe('_main_');
		}
	});

	it('assigns CTE names as frameName for CTE queries', async () => {
		const sql = [
			'WITH base AS (',
			'  SELECT id, status FROM raw_orders',
			'),',
			'filtered AS (',
			"  SELECT id FROM base WHERE status = 'completed'",
			')',
			'SELECT * FROM filtered',
		].join('\n');
		const result = await emit(sql);
		expect(result).toBeDefined();
		const symbols = result!.symbols;

		const baseLine = symbols.filter(s => s.line === 1);
		expect(baseLine.length).toBeGreaterThan(0);
		for (const sym of baseLine) expect(sym.frameName).toBe('base');

		const filteredLine = symbols.filter(s => s.line === 4);
		expect(filteredLine.length).toBeGreaterThan(0);
		for (const sym of filteredLine) expect(sym.frameName).toBe('filtered');

		const mainLine = symbols.filter(s => s.line === 6);
		expect(mainLine.length).toBeGreaterThan(0);
		for (const sym of mainLine) expect(sym.frameName).toBe('_main_');
	});

	it('filters out blanked Jinja tokens', async () => {
		const sql = "SELECT id FROM {{ ref('orders') }} WHERE id > 1";
		const result = await emit(sql);
		expect(result).toBeDefined();
		const symbols = result!.symbols;
		const jinjaSymbol = symbols.find(s => s.col >= 15 && s.col < 34);
		expect(jinjaSymbol).toBeUndefined();
		const roles = symbols.map(s => s.role);
		expect(roles).toContain('select');
		expect(roles).toContain('from');
		expect(roles).toContain('where');
	});

	it('detects function calls', async () => {
		const result = await emit('SELECT COUNT(id) FROM t');
		expect(result).toBeDefined();
		const fnSym = result!.symbols.find(s => s.role === 'fn');
		expect(fnSym).toBeDefined();
		expect(fnSym!.line).toBe(0);
	});

	it('returns undefined for empty SQL', async () => {
		const result = await emit('');
		expect(result).toBeUndefined();
	});
});
