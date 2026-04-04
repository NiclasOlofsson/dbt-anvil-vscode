import { describe, expect, it } from 'vitest';
import {
	findJinjaSpans,
	injectMarkers,
	parseSourceMap,
	type SymbolEntry,
} from '../dbt/debug-symbols';

describe('findJinjaSpans', () => {
	it('finds expression tags {{ }}', () => {
		const source = "SELECT {{ ref('orders') }} FROM t";
		const spans = findJinjaSpans(source);
		expect(spans).toEqual([{ start: 7, end: 26 }]);
	});

	it('finds block tags {% %}', () => {
		const source = '{% if flag %}SELECT 1{% endif %}';
		const spans = findJinjaSpans(source);
		expect(spans).toEqual([
			{ start: 0, end: 13 },
			{ start: 21, end: 32 },
		]);
	});

	it('finds comment tags {# #}', () => {
		const source = '{# a comment #} SELECT 1';
		const spans = findJinjaSpans(source);
		expect(spans).toEqual([{ start: 0, end: 15 }]);
	});

	it('finds all three types in one string', () => {
		const source = "{% if x %}SELECT {{ ref('t') }} FROM t{# note #}";
		const spans = findJinjaSpans(source);
		expect(spans).toHaveLength(3);
		expect(spans[0]).toEqual({ start: 0, end: 10 });
		expect(spans[1]).toEqual({ start: 17, end: 31 });
		expect(spans[2]).toEqual({ start: 38, end: 48 });
	});

	it('handles nested {{ }} (brace counting)', () => {
		const source = "{{ config(post_hook=\"COPY {{ this }}\") }}";
		const spans = findJinjaSpans(source);
		// Should be one span covering the entire outer {{ }}
		expect(spans).toHaveLength(1);
		expect(spans[0]).toEqual({ start: 0, end: source.length });
	});

	it('returns empty for plain SQL', () => {
		expect(findJinjaSpans('SELECT 1 FROM t WHERE id > 0')).toEqual([]);
	});

	it('handles adjacent blocks', () => {
		const source = '{{ a }}{{ b }}';
		const spans = findJinjaSpans(source);
		expect(spans).toEqual([
			{ start: 0, end: 7 },
			{ start: 7, end: 14 },
		]);
	});

	it('handles multiline block tags', () => {
		const source = '{% if\n  flag\n%}SELECT 1{% endif %}';
		const spans = findJinjaSpans(source);
		expect(spans).toHaveLength(2);
		expect(spans[0]).toEqual({ start: 0, end: 15 });
	});
});

describe('injectMarkers', () => {
	it('inserts paired open/close markers around tokens', () => {
		const source = 'SELECT id FROM t';
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
			{ line: 0, col: 7, endCol: 9, role: 'ident' },
			{ line: 0, col: 10, endCol: 14, role: 'from' },
			{ line: 0, col: 15, endCol: 16, role: 'ident' },
		];
		const result = injectMarkers(source, symbols, []);

		expect(result).toContain('/* @dbg:L0:C0:select */');
		expect(result).toContain('/* /@dbg */');
		// Each symbol gets a pair
		const openCount = (result.match(/\/\* @dbg:/g) ?? []).length;
		const closeCount = (result.match(/\/\* \/@dbg \*\//g) ?? []).length;
		expect(openCount).toBe(4);
		expect(closeCount).toBe(4);
	});

	it('preserves right-to-left insertion order', () => {
		const source = 'SELECT a, b FROM t';
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
			{ line: 0, col: 7, endCol: 8, role: 'ident' },
			{ line: 0, col: 10, endCol: 11, role: 'ident' },
			{ line: 0, col: 12, endCol: 16, role: 'from' },
			{ line: 0, col: 17, endCol: 18, role: 'ident' },
		];
		const result = injectMarkers(source, symbols, []);

		// All original tokens should still appear in order
		const stripped = result.replace(/\/\* @dbg:\w+:\w+:\w+(?::\w+)? \*\/ /g, '').replace(/ \/\* \/@dbg \*\//g, '');
		expect(stripped).toBe(source);
	});

	it('skips symbols inside Jinja spans', () => {
		const source = "SELECT {{ ref('orders') }} FROM t";
		const spans = findJinjaSpans(source);
		// Pretend the bridge returned a symbol at position 7 (inside {{ }})
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
			{ line: 0, col: 7, endCol: 13, role: 'ident' },  // inside Jinja
			{ line: 0, col: 27, endCol: 31, role: 'from' },
		];
		const result = injectMarkers(source, symbols, spans);

		const openCount = (result.match(/\/\* @dbg:/g) ?? []).length;
		expect(openCount).toBe(2); // only SELECT and FROM, not the Jinja one
	});

	it('handles multiline source', () => {
		const source = 'SELECT\n  id\nFROM\n  t';
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
			{ line: 1, col: 2, endCol: 4, role: 'ident' },
			{ line: 2, col: 0, endCol: 4, role: 'from' },
			{ line: 3, col: 2, endCol: 3, role: 'ident' },
		];
		const result = injectMarkers(source, symbols, []);

		const openCount = (result.match(/\/\* @dbg:/g) ?? []).length;
		expect(openCount).toBe(4);
		// Original tokens preserved
		expect(result).toContain('SELECT');
		expect(result).toContain('FROM');
	});

	it('includes frameName in marker when present', () => {
		const source = 'SELECT id FROM t';
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select', frameName: 'base' },
			{ line: 0, col: 7, endCol: 9, role: 'ident', frameName: 'base' },
		];
		const result = injectMarkers(source, symbols, []);

		expect(result).toContain('/* @dbg:L0:C0:select:base */');
		expect(result).toContain('/* @dbg:L0:C7:ident:base */');
	});

	it('omits frameName suffix when not present', () => {
		const source = 'SELECT id FROM t';
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
		];
		const result = injectMarkers(source, symbols, []);

		expect(result).toContain('/* @dbg:L0:C0:select */');
		expect(result).not.toContain('/* @dbg:L0:C0:select:');
	});

	it('injects @ref markers around ref() Jinja spans', () => {
		const source = "SELECT id FROM {{ ref('orders') }}";
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
			{ line: 0, col: 7, endCol: 9, role: 'ident' },
		];
		const jinjaSpans = findJinjaSpans(source);
		const result = injectMarkers(source, symbols, jinjaSpans, {
			refMarkers: [{ name: 'orders', sourceLine: 0, startOffset: 15, endOffset: 34 }],
		});

		expect(result).toContain('/* @ref:name="orders" source_line=0 */');
		expect(result).toContain('/* /@ref */');
		expect(result).toContain("{{ ref('orders') }}");
	});

	it('injects @source markers around source() Jinja spans', () => {
		const source = "SELECT id FROM {{ source('raw', 'data') }}";
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
		];
		const jinjaSpans = findJinjaSpans(source);
		const result = injectMarkers(source, symbols, jinjaSpans, {
			sourceMarkers: [{ schema: 'raw', name: 'data', sourceLine: 0, startOffset: 15, endOffset: 42 }],
		});

		expect(result).toContain('/* @source:schema="raw" name="data" source_line=0 */');
		expect(result).toContain('/* /@source */');
	});

	it('injects @macro markers around macro Jinja spans', () => {
		const source = "SELECT {{ my_macro(col) }} FROM t";
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
		];
		const jinjaSpans = findJinjaSpans(source);
		const result = injectMarkers(source, symbols, jinjaSpans, {
			macroSpans: [{ name: 'my_macro', sourceLine: 0, startOffset: 7, endOffset: 26 }],
		});

		expect(result).toContain('/* @macro:start name="my_macro" source_line=0 */');
		expect(result).toContain('/* @macro:end */');
	});
});

describe('parseSourceMap', () => {
	it('extracts source mapping from paired markers', () => {
		const compiled = '/* @dbg:L0:C0:select */ SELECT /* /@dbg */ /* @dbg:L0:C7:ident */ id /* /@dbg */ /* @dbg:L0:C10:from */ FROM /* /@dbg */ /* @dbg:L0:C15:ident */ t /* /@dbg */';
		const map = parseSourceMap(compiled);

		expect(map.mappings).toHaveLength(4);
		expect(map.mappings[0].sourceLine).toBe(0);
		expect(map.mappings[0].sourceCol).toBe(0);
		expect(map.mappings[0].role).toBe('select');
	});

	it('sourceToCompiled returns mappings for a source line', () => {
		const compiled = '/* @dbg:L0:C0:select */ SELECT /* /@dbg */ /* @dbg:L0:C7:ident */ id /* /@dbg */';
		const map = parseSourceMap(compiled);

		const line0 = map.sourceToCompiled(0);
		expect(line0).toHaveLength(2);
		expect(line0[0].role).toBe('select');
		expect(line0[1].role).toBe('ident');
	});

	it('compiledToSource returns mappings for compiled line', () => {
		const compiled = '/* @dbg:L0:C0:select */ SELECT /* /@dbg */\n/* @dbg:L1:C2:ident */ id /* /@dbg */';
		const map = parseSourceMap(compiled);

		const line0 = map.compiledToSource(0);
		expect(line0).toHaveLength(1);
		expect(line0[0].sourceLine).toBe(0);

		const line1 = map.compiledToSource(1);
		expect(line1).toHaveLength(1);
		expect(line1[0].sourceLine).toBe(1);
	});

	it('handles Jinja-expanded tokens with different compiled length', () => {
		// Source had {{ ref('orders') }} at L0:C15, compiled to "db"."schema"."orders"
		const compiled = '/* @dbg:L0:C0:select */ SELECT /* /@dbg */ /* @dbg:L0:C7:ident */ id /* /@dbg */ /* @dbg:L0:C10:from */ FROM /* /@dbg */ /* @dbg:L0:C15:ident */ "db"."schema"."orders" /* /@dbg */';
		const map = parseSourceMap(compiled);

		const tableMapping = map.mappings.find(m => m.sourceCol === 15);
		expect(tableMapping).toBeDefined();
		expect(tableMapping!.role).toBe('ident');
		// The compiled range should cover the full expanded identifier
		expect(tableMapping!.compiledCol).toBeLessThan(tableMapping!.compiledEndCol);
	});

	it('handles multi-CTE queries', () => {
		const compiled = [
			'/* @dbg:L0:C0:cte */ WITH /* /@dbg */',
			'/* @dbg:L1:C0:ident */ base /* /@dbg */ AS (',
			'  /* @dbg:L2:C2:select */ SELECT /* /@dbg */ /* @dbg:L2:C9:ident */ id /* /@dbg */ /* @dbg:L2:C12:from */ FROM /* /@dbg */ /* @dbg:L2:C17:ident */ raw /* /@dbg */',
			')',
			'/* @dbg:L4:C0:select */ SELECT /* /@dbg */ /* @dbg:L4:C7:star */ * /* /@dbg */ /* @dbg:L4:C9:from */ FROM /* /@dbg */ /* @dbg:L4:C14:ident */ base /* /@dbg */',
		].join('\n');

		const map = parseSourceMap(compiled);
		expect(map.mappings.length).toBeGreaterThanOrEqual(9);

		const cteSymbols = map.sourceToCompiled(0);
		expect(cteSymbols.some(m => m.role === 'cte')).toBe(true);
	});

	it('returns empty for SQL without markers', () => {
		const map = parseSourceMap('SELECT 1 FROM t');
		expect(map.mappings).toEqual([]);
		expect(map.sourceToCompiled(0)).toEqual([]);
		expect(map.compiledToSource(0)).toEqual([]);
	});

	it('roundtrip: inject then parse preserves Jinja integrity', () => {
		const source = "SELECT id, {{ ref('orders') }} as tbl FROM {{ source('raw', 'data') }}";
		const jinjaSpans = findJinjaSpans(source);

		// Mock symbols (only non-Jinja tokens)
		const symbols: SymbolEntry[] = [
			{ line: 0, col: 0, endCol: 6, role: 'select' },
			{ line: 0, col: 7, endCol: 9, role: 'ident' },
		];

		const annotated = injectMarkers(source, symbols, jinjaSpans);

		// Jinja blocks should remain intact
		expect(annotated).toContain("{{ ref('orders') }}");
		expect(annotated).toContain("{{ source('raw', 'data') }}");

		// Markers should be present
		expect(annotated).toContain('/* @dbg:L0:C0:select */');
		expect(annotated).toContain('/* @dbg:L0:C7:ident */');
	});

	it('parses frameName from marker when present', () => {
		const compiled = '/* @dbg:L0:C0:select:base */ SELECT /* /@dbg */ /* @dbg:L0:C7:ident:base */ id /* /@dbg */';
		const map = parseSourceMap(compiled);

		expect(map.mappings).toHaveLength(2);
		expect(map.mappings[0].frameName).toBe('base');
		expect(map.mappings[1].frameName).toBe('base');
	});

	it('frameName is undefined for markers without it', () => {
		const compiled = '/* @dbg:L0:C0:select */ SELECT /* /@dbg */';
		const map = parseSourceMap(compiled);

		expect(map.mappings).toHaveLength(1);
		expect(map.mappings[0].frameName).toBeUndefined();
	});

	it('parses @macro open/close spans', () => {
		const compiled = '/* @macro:start name="count_macro" source_line=5 */ COUNT(*) /* @macro:end */';
		const map = parseSourceMap(compiled);

		expect(map.macroSpans).toHaveLength(1);
		expect(map.macroSpans[0].name).toBe('count_macro');
		expect(map.macroSpans[0].sourceLine).toBe(5);
		expect(map.macroSpans[0].compiledStartLine).toBe(0);
		expect(map.macroSpans[0].compiledEndLine).toBe(0);
	});

	it('parses @ref markers', () => {
		const compiled = '/* @ref:name="orders" source_line=3 */ "db"."schema"."orders" /* /@ref */';
		const map = parseSourceMap(compiled);

		expect(map.refMarkers).toHaveLength(1);
		expect(map.refMarkers[0].name).toBe('orders');
		expect(map.refMarkers[0].sourceLine).toBe(3);
		expect(map.refMarkers[0].compiledLine).toBe(0);
	});

	it('parses @source markers', () => {
		const compiled = '/* @source:schema="raw" name="data" source_line=7 */ "raw"."data" /* /@source */';
		const map = parseSourceMap(compiled);

		expect(map.sourceMarkers).toHaveLength(1);
		expect(map.sourceMarkers[0].schema).toBe('raw');
		expect(map.sourceMarkers[0].name).toBe('data');
		expect(map.sourceMarkers[0].sourceLine).toBe(7);
		expect(map.sourceMarkers[0].compiledLine).toBe(0);
	});

	it('isInsideMacro returns span when line is inside a macro', () => {
		const compiled = 'line0\n/* @macro:start name="count_macro" source_line=5 */ COUNT(*) /* @macro:end */\nline2';
		const map = parseSourceMap(compiled);

		const span = map.isInsideMacro(1);
		expect(span).toBeDefined();
		expect(span!.sourceLine).toBe(5);
	});

	it('isInsideMacro returns undefined for lines outside macros', () => {
		const compiled = '/* @macro:start name="count_macro" source_line=5 */ COUNT(*) /* @macro:end */\nSELECT 1';
		const map = parseSourceMap(compiled);

		expect(map.isInsideMacro(1)).toBeUndefined();
	});
});
