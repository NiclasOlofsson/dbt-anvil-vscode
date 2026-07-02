/**
 * Unit tests for the sqllens-powered emit path (emitDebugSymbols).
 *
 * Pure-TS: sqllens parses the (jinja-blanked) SQL directly, so these run without
 * Pyodide. A final describe uses Pyodide to compare frames against the legacy
 * token path (emitDebugSymbolsFromTokens) on the same straightforward SQL.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
	emitDebugSymbols,
	emitDebugSymbolsFromTokens,
	findJinjaSpans,
	injectMarkers,
	parseSourceMap,
} from './debug-symbols';
import type { SymbolEntry } from './debug-symbols';
import { initPyodide } from '../ftl/pyodide-loader.js';
import type { PyodideRuntime } from '../ftl/pyodide-loader.js';
import { PyodideSqlParser } from '../ftl/pyodide-sql-parser.js';

// A realistic dbt-model-shaped source: two CTEs (the second with a JOIN and an
// aggregate), a final SELECT *, and {{ ref() }} tags on the FROM/JOIN relations.
const MODEL_SQL = [
	'with', // 0
	'a as (', // 1
	'  select id, status from {{ ref(\'raw_a\') }}', // 2
	'),', // 3
	'b as (', // 4
	'  select a.id, count(x) as n', // 5
	'  from a', // 6
	'  join {{ ref(\'raw_b\') }} rb on rb.id = a.id', // 7
	'  where a.status = \'ok\'', // 8
	'  group by a.id', // 9
	')', // 10
	'select * from b', // 11
].join('\n');

function byRole(symbols: SymbolEntry[], role: string): SymbolEntry[] {
	return symbols.filter(s => s.role === role);
}

/** The one symbol at an exact (line, col), for position assertions. */
function at(symbols: SymbolEntry[], line: number, col: number): SymbolEntry | undefined {
	return symbols.find(s => s.line === line && s.col === col);
}

describe('emitDebugSymbols (sqllens path)', () => {
	it('returns undefined for empty SQL', () => {
		expect(emitDebugSymbols('', 'databricks', [])).toBeUndefined();
	});

	it('emits clause-keyword roles at correct 0-based positions', () => {
		const res = emitDebugSymbols(MODEL_SQL, 'databricks', []);
		expect(res).toBeDefined();
		const s = res!.symbols;

		expect(at(s, 0, 0)).toMatchObject({ role: 'cte', endCol: 4, frameName: '_main_' });
		expect(at(s, 2, 2)).toMatchObject({ role: 'select', endCol: 8, frameName: 'a' });
		expect(at(s, 2, 20)).toMatchObject({ role: 'from', frameName: 'a' });
		expect(at(s, 5, 2)).toMatchObject({ role: 'select', frameName: 'b' });
		expect(at(s, 6, 2)).toMatchObject({ role: 'from', frameName: 'b' });
		expect(at(s, 7, 2)).toMatchObject({ role: 'join', frameName: 'b' });
		expect(at(s, 8, 2)).toMatchObject({ role: 'where', frameName: 'b' });
		expect(at(s, 9, 2)).toMatchObject({ role: 'group', frameName: 'b' });
		expect(at(s, 11, 0)).toMatchObject({ role: 'select', endCol: 6, frameName: '_main_' });
		expect(at(s, 11, 9)).toMatchObject({ role: 'from', frameName: '_main_' });
	});

	it('emits ident / fn / lit / star roles from the right layers', () => {
		const res = emitDebugSymbols(MODEL_SQL, 'databricks', []);
		const s = res!.symbols;

		// Function name only (not the whole call): count on line 5.
		const fn = byRole(s, 'fn');
		expect(fn).toHaveLength(1);
		expect(fn[0]).toMatchObject({ line: 5, col: 15, endCol: 20, frameName: 'b' });

		// String literal 'ok' on line 8, in frame b.
		const lit = byRole(s, 'lit');
		expect(lit).toHaveLength(1);
		expect(lit[0]).toMatchObject({ line: 8, frameName: 'b' });

		// The SELECT * star, in _main_.
		const star = byRole(s, 'star');
		expect(star).toHaveLength(1);
		expect(star[0]).toMatchObject({ line: 11, col: 7, frameName: '_main_' });

		// Column-reference idents (a.id / x / rb / rb.id / a.status …) exist in frame b.
		const idents = byRole(s, 'ident');
		expect(idents.some(i => i.line === 5 && i.col === 9 && i.frameName === 'b')).toBe(true); // a.id
		expect(idents.some(i => i.line === 8 && i.frameName === 'b')).toBe(true); // a.status
	});

	it('groups symbols into the a / b / _main_ frames', () => {
		const res = emitDebugSymbols(MODEL_SQL, 'databricks', []);
		const frames = new Set(res!.symbols.map(s => s.frameName));
		expect(frames).toEqual(new Set(['_main_', 'a', 'b']));

		// Every symbol on a CTE body line carries that CTE's frame.
		for (const s of res!.symbols) {
			if (s.line === 2) expect(s.frameName).toBe('a');
			if (s.line >= 5 && s.line <= 9) expect(s.frameName).toBe('b');
			if (s.line === 11) expect(s.frameName).toBe('_main_');
		}
	});

	it('emits no @dbg markers inside Jinja regions', () => {
		const res = emitDebugSymbols(MODEL_SQL, 'databricks', []);
		const spans = findJinjaSpans(MODEL_SQL);
		const lineStarts = [0];
		for (let i = 0; i < MODEL_SQL.length; i++) if (MODEL_SQL[i] === '\n') lineStarts.push(i + 1);

		// No returned symbol starts inside a Jinja span.
		for (const s of res!.symbols) {
			const offset = lineStarts[s.line] + s.col;
			for (const span of spans) expect(offset >= span.start && offset < span.end).toBe(false);
		}

		// The ref tags survive verbatim in the annotated source (no marker spliced in).
		expect(res!.annotatedSource).toContain('{{ ref(\'raw_a\') }}');
		expect(res!.annotatedSource).toContain('{{ ref(\'raw_b\') }}');
	});

	it('round-trips through injectMarkers → parseSourceMap with correct frames', () => {
		const res = emitDebugSymbols(MODEL_SQL, 'databricks', []);
		const annotated = injectMarkers(MODEL_SQL, res!.symbols, findJinjaSpans(MODEL_SQL));

		// Simulate dbt compile: swap the refs for table names (same line count).
		const compiled = annotated
			.replace('{{ ref(\'raw_a\') }}', 'main.raw_a')
			.replace('{{ ref(\'raw_b\') }}', 'main.raw_b');
		const sm = parseSourceMap(compiled);

		// Frames survive the marker round-trip.
		const selectFrames = sm.mappings.filter(m => m.role === 'select').map(m => m.frameName);
		expect(selectFrames).toContain('a');
		expect(selectFrames).toContain('b');
		expect(selectFrames).toContain('_main_');

		// A frame-tagged clause maps back to its source line.
		const joinMapping = sm.mappings.find(m => m.role === 'join');
		expect(joinMapping).toBeDefined();
		expect(joinMapping!.frameName).toBe('b');
		expect(joinMapping!.sourceLine).toBe(7);
	});

	it('names a nested subquery frame by its alias', () => {
		const sql = [
			'select o.id, s.total', // 0
			'from orders o', // 1
			'join (', // 2
			'  select order_id, sum(amount) as total', // 3
			'  from items', // 4
			'  group by order_id', // 5
			') s on s.order_id = o.id', // 6
		].join('\n');
		const res = emitDebugSymbols(sql, 'databricks', []);
		expect(res).toBeDefined();

		// The subquery body (lines 3–5) lives in frame 's'; the outer query in _main_.
		for (const s of res!.symbols) {
			if (s.line >= 3 && s.line <= 5) expect(s.frameName).toBe('s');
		}
		expect(at(res!.symbols, 3, 2)).toMatchObject({ role: 'select', frameName: 's' });
		expect(at(res!.symbols, 0, 0)).toMatchObject({ role: 'select', frameName: '_main_' });
	});

	it('handles a CTE named with a quoted identifier', () => {
		// Databricks quotes identifiers with backticks (double quotes are string literals).
		const sql = [
			'with', // 0
			'`my cte` as (', // 1
			'  select id from raw_x', // 2
			')', // 3
			'select id from `my cte`', // 4
		].join('\n');
		const res = emitDebugSymbols(sql, 'databricks', []);
		expect(res).toBeDefined();

		// The CTE body's clause keywords carry the (unquoted) frame name.
		expect(at(res!.symbols, 2, 2)).toMatchObject({ role: 'select', frameName: 'my cte' });
		expect(at(res!.symbols, 2, 12)).toMatchObject({ role: 'from', frameName: 'my cte' });
		// The final SELECT is back in _main_.
		expect(at(res!.symbols, 4, 0)).toMatchObject({ role: 'select', frameName: '_main_' });
	});
});

describe('emitDebugSymbols vs emitDebugSymbolsFromTokens (frame parity)', () => {
	const PYODIDE_DIR = path.join(__dirname, '..', '..', 'node_modules', 'pyodide');
	const VENDOR_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl', 'vendor');
	const SCRIPTS_DIR = path.join(__dirname, '..', '..', 'resources', 'ftl');

	let runtime: PyodideRuntime;
	let parser: PyodideSqlParser;

	beforeAll(async () => {
		runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
		parser = PyodideSqlParser.create(runtime.pyodide);
	}, 60_000);

	it('agrees with the legacy token path on CTE-body and main frames', async () => {
		const source = [
			'with', // 0
			'cte_a as (', // 1
			'  select id from raw_a', // 2
			'),', // 3
			'cte_b as (', // 4
			'  select id from raw_b', // 5
			')', // 6
			'select * from cte_b', // 7
		].join('\n');

		const parsed = await parser.parse(source, 'duckdb');
		const legacy = emitDebugSymbolsFromTokens(source, parsed.sqlTokens ?? [], parsed.jinjaTokens ?? []);
		const next = emitDebugSymbols(source, 'duckdb', parsed.jinjaTokens ?? []);
		expect(legacy).toBeDefined();
		expect(next).toBeDefined();

		// The single frame assigned to symbols on a given line (both paths are consistent per line).
		const frameOnLine = (syms: SymbolEntry[], line: number): string | undefined => {
			const f = syms.filter(s => s.line === line).map(s => s.frameName);
			return f.length ? f[0] : undefined;
		};

		// CTE-body lines (2, 5) and the main query line (7) must agree.
		for (const line of [2, 5, 7]) {
			expect(frameOnLine(next!.symbols, line), `line ${line}`).toBe(frameOnLine(legacy!.symbols, line));
		}
		expect(frameOnLine(next!.symbols, 2)).toBe('cte_a');
		expect(frameOnLine(next!.symbols, 5)).toBe('cte_b');
		expect(frameOnLine(next!.symbols, 7)).toBe('_main_');

		// KNOWN DIVERGENCE: on the CTE *declaration* line the legacy walk assigns the
		// CTE frame (its range starts at the name token), while the sqllens path leaves
		// the name in the enclosing scope (_main_) — the CTE name is declared there.
		expect(frameOnLine(legacy!.symbols, 1)).toBe('cte_a');
		expect(frameOnLine(next!.symbols, 1)).toBe('_main_');
	});
});
