/**
 * Unit tests for the debug-symbol emit path (emitDebugSymbols): sqllens parses
 * the (jinja-blanked) SQL directly, symbols and frames come off its Sym model.
 */
import { describe, expect, it } from 'vitest';
import {
	emitDebugSymbols,
	findJinjaSpans,
	injectMarkers,
	parseSourceMap,
} from '../../dbt/debug-symbols';
import type { SymbolEntry } from '../../dbt/debug-symbols';

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
		expect(emitDebugSymbols('', 'databricks')).toBeUndefined();
	});

	it('emits clause-keyword roles at correct 0-based positions', () => {
		const res = emitDebugSymbols(MODEL_SQL, 'databricks');
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
		const res = emitDebugSymbols(MODEL_SQL, 'databricks');
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
		const res = emitDebugSymbols(MODEL_SQL, 'databricks');
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
		const res = emitDebugSymbols(MODEL_SQL, 'databricks');
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
		const res = emitDebugSymbols(MODEL_SQL, 'databricks');
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
		const res = emitDebugSymbols(sql, 'databricks');
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
		const res = emitDebugSymbols(sql, 'databricks');
		expect(res).toBeDefined();

		// The CTE body's clause keywords carry the (unquoted) frame name.
		expect(at(res!.symbols, 2, 2)).toMatchObject({ role: 'select', frameName: 'my cte' });
		expect(at(res!.symbols, 2, 12)).toMatchObject({ role: 'from', frameName: 'my cte' });
		// The final SELECT is back in _main_.
		expect(at(res!.symbols, 4, 0)).toMatchObject({ role: 'select', frameName: '_main_' });
	});
});

describe('emitDebugSymbols — frame attribution on a plain CTE chain', () => {
	it('assigns CTE-body frames by name and the final select to _main_', () => {
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

		const res = emitDebugSymbols(source, 'duckdb');
		expect(res).toBeDefined();

		// The single frame assigned to symbols on a given line.
		const frameOnLine = (syms: SymbolEntry[], line: number): string | undefined => {
			const f = syms.filter(s => s.line === line).map(s => s.frameName);
			return f.length ? f[0] : undefined;
		};

		expect(frameOnLine(res!.symbols, 2)).toBe('cte_a');
		expect(frameOnLine(res!.symbols, 5)).toBe('cte_b');
		expect(frameOnLine(res!.symbols, 7)).toBe('_main_');
		// The CTE *declaration* line stays in the enclosing scope (_main_) —
		// the CTE name is declared there, its body frame starts at the paren.
		expect(frameOnLine(res!.symbols, 1)).toBe('_main_');
	});
});

// dbt compiles exactly ONE jinja arm, chosen at render time from real state — a
// choice emit cannot predict. So emit must mark EVERY arm, and whichever arm dbt
// keeps carries its markers. Symbols come from sqllens's unionSymbols() (all-arm
// idents/fns); keywords/star/lits come from the all-text-live placeholder lex.
describe('emitDebugSymbols — jinja arm coverage', () => {
	const identsOnLine = (res: SymbolEntry[] | undefined, line: number): SymbolEntry[] =>
		(res ?? []).filter(s => s.line === line && s.role === 'ident');

	it('marks the identifier in BOTH arms of an if/else (not just the primary arm)', () => {
		const source = [
			'select',                     // 0
			'  id,',                      // 1
			'{% if var("flag") %}',       // 2
			'  amount_a as amount',       // 3  if-arm
			'{% else %}',                 // 4
			'  amount_b as amount',       // 5  else-arm
			'{% endif %}',                // 6
			'from {{ ref(\'orders\') }}', // 7
		].join('\n');

		const res = emitDebugSymbols(source, 'databricks');
		// The if-arm ident and the else-arm ident BOTH carry a marker. Before
		// unionSymbols, only the primary (if) arm did, so dbt taking the else branch
		// left `amount_b` with no source mapping.
		expect(identsOnLine(res!.symbols, 3)).toHaveLength(1); // amount_a
		expect(identsOnLine(res!.symbols, 5)).toHaveLength(1); // amount_b
	});

	it('marks the clause keyword in BOTH arms of an if/else', () => {
		const source = [
			'select id',            // 0
			'from {{ ref("t") }}',  // 1
			'{% if var("f") %}',    // 2
			'where a = 1',          // 3  if-arm WHERE
			'{% else %}',           // 4
			'where b = 2',          // 5  else-arm WHERE
			'{% endif %}',          // 6
		].join('\n');

		const res = emitDebugSymbols(source, 'databricks');
		const whereLines = res!.symbols.filter(s => s.role === 'where').map(s => s.line).sort();
		expect(whereLines).toEqual([3, 5]);
	});

	it('marks a for-loop body once; dbt unroll duplicates the marker with the body', () => {
		const source = [
			'{% for t in ["x","y"] %}',      // 0
			'select col from {{ ref(t) }}',  // 1  loop body
			'{% if not loop.last %}union all{% endif %}', // 2
			'{% endfor %}',                  // 3
		].join('\n');

		const res = emitDebugSymbols(source, 'databricks');
		// The loop body's select/from/ident get a marker on the single source line
		// they occupy; dbt unrolls the loop (markers included), so every generated
		// leg stays mapped back to source line 1.
		const line1 = res!.symbols.filter(s => s.line === 1).map(s => s.role).sort();
		expect(line1).toContain('select');
		expect(line1).toContain('from');
		expect(line1).toContain('ident');
	});

	it('plain (non-branched) SQL is unchanged by the union path', () => {
		const source = [
			'select id, amount',  // 0
			'from orders',        // 1
			'where id > 0',       // 2
		].join('\n');
		const res = emitDebugSymbols(source, 'databricks');
		const roles = res!.symbols.map(s => `${s.role}@${s.line}`).sort();
		// select + two idents on L0, from on L1, where + ident + lit on L2.
		expect(roles).toContain('select@0');
		expect(roles).toContain('from@1');
		expect(roles).toContain('where@2');
	});
});

describe('emitDebugSymbols — ref/source markers off the tag-AST', () => {
	it('emits a ref marker for the plain single-arg form', () => {
		const res = emitDebugSymbols('select id from {{ ref(\'customers\') }}', 'databricks');
		expect(res!.refMarkers).toHaveLength(1);
		expect(res!.refMarkers[0]).toMatchObject({ name: 'customers', sourceLine: 0 });
	});

	// dbt resolves the LAST positional arg as the model in the two-arg
	// package form; the marker must name the model, not the package.
	it('emits a ref marker for the two-arg ref(\'pkg\',\'model\') form', () => {
		const res = emitDebugSymbols('select id from {{ ref(\'some_pkg\', \'customers\') }}', 'databricks');
		expect(res!.refMarkers).toHaveLength(1);
		expect(res!.refMarkers[0]).toMatchObject({ name: 'customers', sourceLine: 0 });
	});

	it('emits a ref marker for the keyword-arg ref(model=...) form', () => {
		const res = emitDebugSymbols('select id from {{ ref(model=\'customers\') }}', 'databricks');
		expect(res!.refMarkers).toHaveLength(1);
		expect(res!.refMarkers[0]).toMatchObject({ name: 'customers', sourceLine: 0 });
	});

	it('emits a source marker with schema and table', () => {
		const res = emitDebugSymbols('select id from {{ source(\'raw\', \'orders\') }}', 'databricks');
		expect(res!.sourceMarkers).toHaveLength(1);
		expect(res!.sourceMarkers[0]).toMatchObject({ schema: 'raw', name: 'orders', sourceLine: 0 });
	});

	it('emits nothing for a computed ref arg', () => {
		const res = emitDebugSymbols('select id from {{ ref(var(\'m\')) }}', 'databricks');
		expect(res!.refMarkers).toHaveLength(0);
	});
});

describe('emitDebugSymbols — clause anchors off clausesOf (sqllens 1.7.0)', () => {
	it('emits a qualify clause anchor', () => {
		const sql = [
			'select id, row_number() over (order by id) as rn', // 0
			'from orders', // 1
			'qualify rn = 1', // 2
		].join('\n');
		const res = emitDebugSymbols(sql, 'databricks');
		const q = res!.symbols.find(s => s.role === 'qualify');
		expect(q).toMatchObject({ line: 2, col: 0, frameName: '_main_' });
	});

	it('a group anchor spans the full GROUP BY keyword phrase', () => {
		const res = emitDebugSymbols('select a, count(*) from t\ngroup by a', 'databricks');
		const g = res!.symbols.find(s => s.role === 'group')!;
		expect(g).toMatchObject({ line: 1, col: 0, endCol: 8 });
	});
});
