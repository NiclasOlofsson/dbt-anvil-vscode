/**
 * Integration tests for emit_debug_symbols via FTL/Pyodide.
 *
 * Uses the PyodideSqlParser to generate tokens and Jinja spans, then
 * exercises emitDebugSymbolsFromTokens and the source-map pipeline end-to-end.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { emitDebugSymbolsFromTokens, findJinjaSpans, injectMarkers, parseSourceMap, type SymbolEntry } from '../dbt/debug-symbols';
import { initPyodide } from '../ftl/pyodide-loader.js';
import type { PyodideRuntime } from '../ftl/pyodide-loader.js';
import { PyodideSqlParser } from '../ftl/pyodide-sql-parser.js';

describe('emitDebugSymbolsFromTokens', () => {
	const PYODIDE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pyodide');
	const VENDOR_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl', 'vendor');
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
			'  SELECT id FROM base WHERE status = \'completed\'',
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
			'  SELECT id FROM base WHERE status = \'completed\'',
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
		const sql = 'SELECT id FROM {{ ref(\'orders\') }} WHERE id > 1';
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

	it('roundtrip: decompose frame lines survive inject→compile→parse→remap cycle', async () => {
		// Full end-to-end for a 2-CTE query without Jinja (FTL path):
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

		const emitResult = await emit(source);
		const symbols = emitResult!.symbols;
		const annotated = injectMarkers(source, symbols, findJinjaSpans(source));

		// No Jinja → compiled == annotated
		const compiled = annotated;
		const sourceMap = parseSourceMap(compiled);

		const decomposed = JSON.parse(parser.decomposeQuery(compiled, 'duckdb')) as {
			success: boolean;
			frames: Array<{ name: string; line: number; endLine: number }>;
		};
		expect(decomposed.success).toBe(true);

		const cteA = decomposed.frames.find(f => f.name === 'cte_a');
		const cteB = decomposed.frames.find(f => f.name === 'cte_b');
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

		const emitResult = await emit(source);
		const symbols = emitResult!.symbols;
		const annotated = injectMarkers(source, symbols, findJinjaSpans(source));

		// Simulate dbt compile: replace Jinja with table names (same line count)
		const compiled = annotated
			.replace('{{ ref(\'raw_a\') }}', 'main.raw_a')
			.replace('{{ ref(\'raw_b\') }}', 'main.raw_b');

		const sourceMap = parseSourceMap(compiled);

		const decomposed = JSON.parse(parser.decomposeQuery(compiled, 'duckdb')) as {
			success: boolean;
			frames: Array<{ name: string; line: number; endLine: number }>;
		};
		expect(decomposed.success).toBe(true);

		const cteA = decomposed.frames.find(f => f.name === 'cte_a');
		const cteB = decomposed.frames.find(f => f.name === 'cte_b');
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

describe('decompose_query subquery promotion (FTL)', () => {
	const PYODIDE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pyodide');
	const VENDOR_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl', 'vendor');
	const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl');

	let runtime: PyodideRuntime;
	let parser: PyodideSqlParser;

	beforeAll(async () => {
		runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
		parser = PyodideSqlParser.create(runtime.pyodide);
	}, 60_000);

	function decompose(sql: string, dialect = 'duckdb') {
		return JSON.parse(parser.decomposeQuery(sql, dialect)) as {
			success: boolean;
			frames: Array<{ name: string; type: string; line: number; endLine: number }>;
			refs: Record<string, string[]>;
		};
	}

	it('promotes a FROM subquery to a synthetic CTE frame', async () => {
		const sql = [
			'SELECT t.id, t.name',
			'FROM (SELECT id, name FROM raw_customers WHERE active = 1) t',
		].join('\n');

		const result = decompose(sql);
		expect(result.success).toBe(true);

		// Synthetic frame promoted from the FROM subquery (alias 't' used as CTE name)
		const syntheticFrame = result.frames.find(f => f.name === 't');
		expect(syntheticFrame, 'synthetic frame for FROM subquery').toBeDefined();
		expect(syntheticFrame!.type).toBe('cte');

		// _main_ refs should now point to the synthetic CTE 't'
		expect(result.refs['_main_']).toContain('t');
	});

	it('promotes a JOIN subquery to a synthetic CTE frame', async () => {
		const sql = [
			'WITH base AS (SELECT id FROM raw_orders)',
			'SELECT b.id, w.total',
			'FROM base b',
			'INNER JOIN (SELECT order_id, sum(amount) AS total FROM raw_items GROUP BY ALL) w',
			'  ON b.id = w.order_id',
		].join('\n');

		const result = decompose(sql);
		expect(result.success).toBe(true);

		// 'w' is the JOIN subquery alias → becomes a synthetic CTE named 'w'
		const syntheticFrame = result.frames.find(f => f.name === 'w');
		expect(syntheticFrame, 'synthetic frame for JOIN subquery').toBeDefined();
		expect(syntheticFrame!.type).toBe('cte');

		// _main_ (which sees base and w) should ref both
		expect(result.refs['_main_']).toContain('w');

		// base CTE should still exist
		expect(result.frames.find(f => f.name === 'base')).toBeDefined();
	});

	it('handles a subquery with no alias using a generated name', async () => {
		const sql = 'SELECT * FROM (SELECT id FROM raw_customers) AS anon_sub';

		const result = decompose(sql);
		expect(result.success).toBe(true);

		// 'anon_sub' alias used as CTE name
		expect(result.frames.find(f => f.name === 'anon_sub')).toBeDefined();
	});
});
