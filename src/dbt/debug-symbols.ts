import { iterJinjaTags } from './jinja-blanker';
import { buildLineStarts, lineAtOffset } from '../ftl/jinja-spans';
import type { SqlToken } from '../ftl/parse-result';
import type { JinjaToken } from '../ftl/jinja-tokenizer';

export interface SymbolEntry {
	line: number;
	col: number;
	endCol: number;
	role: string;
	frameName?: string;
}

export interface JinjaSpan {
	start: number;
	end: number;
}

export interface SourceMapping {
	sourceLine: number;
	sourceCol: number;
	compiledLine: number;
	compiledCol: number;
	compiledEndLine: number;
	compiledEndCol: number;
	role: string;
	frameName?: string;
}

export interface MacroSpan {
	name: string;
	sourceLine: number;
	compiledStartLine: number;
	compiledEndLine: number;
}

export interface RefMarker {
	name: string;
	sourceLine: number;
	compiledLine: number;
	compiledCol: number;
	compiledEndCol: number;
}

export interface SourceMarker {
	schema: string;
	name: string;
	sourceLine: number;
	compiledLine: number;
	compiledCol: number;
	compiledEndCol: number;
}

export interface SourceMap {
	mappings: SourceMapping[];
	macroSpans: MacroSpan[];
	refMarkers: RefMarker[];
	sourceMarkers: SourceMarker[];
	sourceToCompiled(line: number): SourceMapping[];
	compiledToSource(line: number): SourceMapping[];
	/**
	 * Dense mapping for compiled SQL lines that contain SQL text.
	 * Returns undefined for blank/marker-only lines, or lines with no marker coverage.
	 */
	compiledLineToSourceLine(compiledLine: number): number | undefined;
	isInsideMacro(compiledLine: number): MacroSpan | undefined;
}

const MARKER_OPEN_RE = /\/\* @dbg:L(\d+):C(\d+):(\w+)(?::([^\s*]+))? \*\//g;
const MARKER_CLOSE_RE = /\/\* \/@dbg \*\//g;

export function findJinjaSpans(source: string): JinjaSpan[] {
	const spans: JinjaSpan[] = [];
	const n = source.length;
	let i = 0;

	while (i < n) {
		if (source[i] !== '{' || i + 1 >= n) {
			i++;
			continue;
		}
		const nxt = source[i + 1];

		if (nxt === '{') {
			const start = i;
			let depth = 0;
			let j = i;
			while (j < n) {
				if (source[j] === '{' && j + 1 < n && source[j + 1] === '{') {
					depth++;
					j += 2;
				} else if (source[j] === '}' && j + 1 < n && source[j + 1] === '}') {
					depth--;
					j += 2;
					if (depth === 0) break;
				} else {
					j++;
				}
			}
			if (depth === 0) {
				spans.push({ start, end: j });
			}
			i = j;
		} else if (nxt === '%') {
			const start = i;
			const close = source.indexOf('%}', i + 2);
			if (close === -1) break;
			const j = close + 2;
			spans.push({ start, end: j });
			i = j;
		} else if (nxt === '#') {
			const start = i;
			const close = source.indexOf('#}', i + 2);
			if (close === -1) break;
			const j = close + 2;
			spans.push({ start, end: j });
			i = j;
		} else {
			i++;
		}
	}

	return spans;
}

export interface JinjaClassification {
	macroSpans?: BridgeMacroSpan[];
	refMarkers?: BridgeRefMarker[];
	sourceMarkers?: BridgeSourceMarker[];
}

export function injectMarkers(
	source: string,
	symbols: SymbolEntry[],
	jinjaSpans: JinjaSpan[],
	jinjaClassifications?: JinjaClassification,
): string {
	// Build line_starts for (line, col) → char offset conversion
	const lineStarts: number[] = [0];
	for (let i = 0; i < source.length; i++) {
		if (source[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}

	function toOffset(line: number, col: number): number {
		return (lineStarts[line] ?? 0) + col;
	}

	function inJinja(offset: number): boolean {
		for (const span of jinjaSpans) {
			if (offset >= span.start && offset < span.end) return true;
		}
		return false;
	}

	// Collect Jinja span markers (inserted around Jinja regions, not SQL tokens)
	type SpanEntry = { startOffset: number; endOffset: number; openMarker: string; closeMarker: string };
	const jinjaEntries: SpanEntry[] = [];

	if (jinjaClassifications) {
		for (const m of jinjaClassifications.macroSpans ?? []) {
			jinjaEntries.push({
				startOffset: m.startOffset,
				endOffset: m.endOffset,
				openMarker: `/* @macro:start name="${m.name}" source_line=${m.sourceLine} */`,
				closeMarker: '/* @macro:end */',
			});
		}
		for (const r of jinjaClassifications.refMarkers ?? []) {
			jinjaEntries.push({
				startOffset: r.startOffset,
				endOffset: r.endOffset,
				openMarker: `/* @ref:name="${r.name}" source_line=${r.sourceLine} */`,
				closeMarker: '/* /@ref */',
			});
		}
		for (const s of jinjaClassifications.sourceMarkers ?? []) {
			jinjaEntries.push({
				startOffset: s.startOffset,
				endOffset: s.endOffset,
				openMarker: `/* @source:schema="${s.schema}" name="${s.name}" source_line=${s.sourceLine} */`,
				closeMarker: '/* /@source */',
			});
		}
	}

	// Filter + compute char offsets, then sort descending for right-to-left insertion
	const entries = symbols
		.map(s => {
			const framePart = s.frameName ? `:${s.frameName}` : '';
			return {
				startOffset: toOffset(s.line, s.col),
				endOffset: toOffset(s.line, s.endCol),
				marker: `/* @dbg:L${s.line}:C${s.col}:${s.role}${framePart} */`,
			};
		})
		.filter(e => !inJinja(e.startOffset))
		.sort((a, b) => b.startOffset - a.startOffset);

	let result = source;

	// First pass: insert @dbg markers (right-to-left)
	for (const e of entries) {
		result = result.slice(0, e.endOffset) + ' /* /@dbg */' + result.slice(e.endOffset);
		result = result.slice(0, e.startOffset) + e.marker + ' ' + result.slice(e.startOffset);
	}

	// Second pass: insert Jinja span markers (right-to-left).
	// We must work on the ORIGINAL offsets, but since @dbg markers only apply
	// to non-Jinja regions, the Jinja span offsets still index into the
	// original source. So we compute shifts caused by @dbg insertions.
	if (jinjaEntries.length > 0) {
		// Sort entries descending by startOffset for right-to-left
		const sortedJinja = [...jinjaEntries].sort((a, b) => b.startOffset - a.startOffset);

		// Compute shift from @dbg marker insertions:
		// Each entry adds an open marker + space BEFORE and space + close marker AFTER
		// Build a sorted array of (offset, delta) for binary-search shift lookup.
		type Insertion = { offset: number; delta: number };
		const insertions: Insertion[] = [];
		for (const e of entries) {
			// Entries are already sorted descending, but let's build ascending
			insertions.push({ offset: e.startOffset, delta: e.marker.length + 1 });
			insertions.push({ offset: e.endOffset, delta: ' /* /@dbg */'.length });
		}
		insertions.sort((a, b) => a.offset - b.offset);

		// Compute cumulative shift at each insertion point
		const cumShifts: { offset: number; cumDelta: number }[] = [];
		let cum = 0;
		for (const ins of insertions) {
			cum += ins.delta;
			cumShifts.push({ offset: ins.offset, cumDelta: cum });
		}

		function shiftAt(origOffset: number): number {
			// Binary search for how much shift has been applied before this offset
			let lo = 0;
			let hi = cumShifts.length - 1;
			let shift = 0;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (cumShifts[mid].offset < origOffset) {
					shift = cumShifts[mid].cumDelta;
					lo = mid + 1;
				} else {
					hi = mid - 1;
				}
			}
			return shift;
		}

		for (const je of sortedJinja) {
			const adjustedStart = je.startOffset + shiftAt(je.startOffset);
			const adjustedEnd = je.endOffset + shiftAt(je.endOffset);
			// Insert close marker after the Jinja span, then open marker before (right-to-left)
			result = result.slice(0, adjustedEnd) + ' ' + je.closeMarker + result.slice(adjustedEnd);
			result = result.slice(0, adjustedStart) + je.openMarker + ' ' + result.slice(adjustedStart);
		}
	}

	return result;
}

export function parseSourceMap(compiledSql: string): SourceMap {
	const mappings: SourceMapping[] = [];
	const compiledLines = compiledSql.split('\n');

	// Build line_starts for the compiled SQL
	const lineStarts: number[] = [0];
	for (let i = 0; i < compiledSql.length; i++) {
		if (compiledSql[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}

	function offsetToLine(offset: number): number {
		let lo = 0;
		let hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	}

	function offsetToCol(offset: number): number {
		const line = offsetToLine(offset);
		return offset - lineStarts[line];
	}

	// Find all open markers and pair with immediately following close marker
	const openRe = /\/\* @dbg:L(\d+):C(\d+):(\w+)(?::([^\s*]+))? \*\//g;
	const closeRe = /\/\* \/@dbg \*\//g;
	let openMatch: RegExpExecArray | null;

	while ((openMatch = openRe.exec(compiledSql)) !== null) {
		const sourceLine = parseInt(openMatch[1], 10);
		const sourceCol = parseInt(openMatch[2], 10);
		const role = openMatch[3];
		const frameName = openMatch[4]; // undefined when no frameName in marker

		// The compiled content starts right after the open marker + space
		const contentStart = openMatch.index + openMatch[0].length + 1;

		// Find the next close marker after this open marker
		closeRe.lastIndex = contentStart;
		const closeMatch = closeRe.exec(compiledSql);
		if (!closeMatch) continue;

		// Content ends at the space before the close marker
		const contentEnd = closeMatch.index - 1;

		const mapping: SourceMapping = {
			sourceLine,
			sourceCol,
			compiledLine: offsetToLine(contentStart),
			compiledCol: offsetToCol(contentStart),
			compiledEndLine: offsetToLine(contentEnd),
			compiledEndCol: offsetToCol(contentEnd),
			role,
		};
		if (frameName) mapping.frameName = frameName;
		mappings.push(mapping);
	}

	// Parse @macro:start / @macro:end span markers
	const macroSpans: MacroSpan[] = [];
	const macroStartRe = /\/\* @macro:start name="([^"]+)" source_line=(\d+) \*\//g;
	const macroEndRe = /\/\* @macro:end \*\//g;
	let macroStartMatch: RegExpExecArray | null;
	while ((macroStartMatch = macroStartRe.exec(compiledSql)) !== null) {
		const macroName = macroStartMatch[1];
		const macroSourceLine = parseInt(macroStartMatch[2], 10);
		const startLine = offsetToLine(macroStartMatch.index);
		macroEndRe.lastIndex = macroStartMatch.index + macroStartMatch[0].length;
		const macroEndMatch = macroEndRe.exec(compiledSql);
		if (!macroEndMatch) continue;
		const endLine = offsetToLine(macroEndMatch.index);
		macroSpans.push({ name: macroName, sourceLine: macroSourceLine, compiledStartLine: startLine, compiledEndLine: endLine });
	}

	// Parse @ref markers
	const refMarkers: RefMarker[] = [];
	const refOpenRe = /\/\* @ref:name="([^"]+)" source_line=(\d+) \*\//g;
	const refCloseRe = /\/\* \/@ref \*\//g;
	let refMatch: RegExpExecArray | null;
	while ((refMatch = refOpenRe.exec(compiledSql)) !== null) {
		const refName = refMatch[1];
		const refSourceLine = parseInt(refMatch[2], 10);
		const contentStart = refMatch.index + refMatch[0].length + 1;
		refCloseRe.lastIndex = contentStart;
		const refCloseMatch = refCloseRe.exec(compiledSql);
		if (!refCloseMatch) continue;
		const contentEnd = refCloseMatch.index - 1;
		refMarkers.push({
			name: refName,
			sourceLine: refSourceLine,
			compiledLine: offsetToLine(contentStart),
			compiledCol: offsetToCol(contentStart),
			compiledEndCol: offsetToCol(contentEnd),
		});
	}

	// Parse @source markers
	const sourceMarkers: SourceMarker[] = [];
	const srcOpenRe = /\/\* @source:schema="([^"]+)" name="([^"]+)" source_line=(\d+) \*\//g;
	const srcCloseRe = /\/\* \/@source \*\//g;
	let srcMatch: RegExpExecArray | null;
	while ((srcMatch = srcOpenRe.exec(compiledSql)) !== null) {
		const srcSchema = srcMatch[1];
		const srcName = srcMatch[2];
		const srcSourceLine = parseInt(srcMatch[3], 10);
		const contentStart = srcMatch.index + srcMatch[0].length + 1;
		srcCloseRe.lastIndex = contentStart;
		const srcCloseMatch = srcCloseRe.exec(compiledSql);
		if (!srcCloseMatch) continue;
		const contentEnd = srcCloseMatch.index - 1;
		sourceMarkers.push({
			schema: srcSchema,
			name: srcName,
			sourceLine: srcSourceLine,
			compiledLine: offsetToLine(contentStart),
			compiledCol: offsetToCol(contentStart),
			compiledEndCol: offsetToCol(contentEnd),
		});
	}

	// Build lookup indexes
	const bySourceLine = new Map<number, SourceMapping[]>();
	const byCompiledLine = new Map<number, SourceMapping[]>();
	for (const m of mappings) {
		const sl = bySourceLine.get(m.sourceLine);
		if (sl) sl.push(m);
		else bySourceLine.set(m.sourceLine, [m]);

		const cl = byCompiledLine.get(m.compiledLine);
		if (cl) cl.push(m);
		else byCompiledLine.set(m.compiledLine, [m]);
	}

	function hasSqlTextOnCompiledLine(compiledLine: number): boolean {
		if (compiledLine < 0 || compiledLine >= compiledLines.length) return false;
		const line = compiledLines[compiledLine];
		const withoutMarkers = line
			.replace(MARKER_OPEN_RE, '')
			.replace(MARKER_CLOSE_RE, '')
			.trim();
		return withoutMarkers.length > 0;
	}

	return {
		mappings,
		macroSpans,
		refMarkers,
		sourceMarkers,
		sourceToCompiled(line: number): SourceMapping[] {
			return bySourceLine.get(line) ?? [];
		},
		compiledToSource(line: number): SourceMapping[] {
			return byCompiledLine.get(line) ?? [];
		},
		compiledLineToSourceLine(compiledLine: number): number | undefined {
			if (!hasSqlTextOnCompiledLine(compiledLine)) return undefined;
			const exact = byCompiledLine.get(compiledLine);
			if (exact && exact.length > 0) return exact[0].sourceLine;
			return undefined;
		},
		isInsideMacro(compiledLine: number): MacroSpan | undefined {
			return macroSpans.find(s => compiledLine >= s.compiledStartLine && compiledLine <= s.compiledEndLine);
		},
	};
}

// ---------------------------------------------------------------------------
// emitDebugSymbolsFromTokens — pure-TS port of bridge emit_debug_symbols
// ---------------------------------------------------------------------------

const STATEMENT_MACROS = new Set(['config', 'docs', 'print', 'log', 'return', 'exceptions']);
const VALUE_MACROS = new Set(['var', 'env_var']);

const TOKEN_ROLE_MAP: Record<string, string> = {
	SELECT: 'select',
	FROM: 'from',
	JOIN: 'join',
	INNER: 'join',
	LEFT: 'join',
	RIGHT: 'join',
	CROSS: 'join',
	FULL: 'join',
	WHERE: 'where',
	GROUP_BY: 'group',
	HAVING: 'having',
	ORDER_BY: 'order',
	LIMIT: 'limit',
	SORT_BY: 'sort',
	CLUSTER_BY: 'cluster',
	DISTRIBUTE_BY: 'distribute',
	OFFSET: 'offset',
	WITH: 'cte',
	STAR: 'star',
};

const MACRO_NAME_RE = /^\{\{\s*(?:[a-zA-Z_]\w*\.)*([a-zA-Z_]\w*)\s*\(/;
const REF_TAG_RE = /\{\{[^}]*ref\(\s*['"]([^'"]+)['"]\s*\)[^}]*\}\}/;
const SOURCE_TAG_RE = /\{\{[^}]*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)[^}]*\}\}/;

function buildCteRanges(
	tokens: SqlToken[],
	source: string,
): Array<{ name: string; startLine: number; endLine: number }> {
	const ranges: Array<{ name: string; startLine: number; endLine: number }> = [];
	const withIdx = tokens.findIndex(t => t.type === 'WITH');
	if (withIdx === -1) return ranges;

	let i = withIdx + 1;
	while (i < tokens.length) {
		while (i < tokens.length && tokens[i].type !== 'VAR') {
			if (tokens[i].type === 'SELECT' || tokens[i].type === 'FROM') return ranges;
			i++;
		}
		if (i >= tokens.length) break;

		const nameToken = tokens[i];
		const cteName = source.slice(nameToken.start, nameToken.end + 1);
		const startLine = nameToken.line;
		i++;

		if (i >= tokens.length || tokens[i].type !== 'ALIAS') break;
		i++;

		if (i >= tokens.length || tokens[i].type !== 'L_PAREN') break;
		i++;

		let depth = 1;
		let endLine = startLine;
		while (i < tokens.length && depth > 0) {
			if (tokens[i].type === 'L_PAREN') depth++;
			else if (tokens[i].type === 'R_PAREN') {
				depth--;
				if (depth === 0) endLine = tokens[i].line;
			}
			i++;
		}

		ranges.push({ name: cteName, startLine, endLine });

		if (i < tokens.length && tokens[i].type === 'COMMA') {
			i++;
		} else {
			break;
		}
	}
	return ranges;
}

export function emitDebugSymbolsFromTokens(
	source: string,
	tokens: SqlToken[],
	jinjaTokens: JinjaToken[],
): EmitResult | undefined {
	if (tokens.length === 0) return undefined;

	const lineStarts = buildLineStarts(source);
	const jinjaSpans = findJinjaSpans(source);

	function inJinja(offset: number): boolean {
		return jinjaSpans.some(s => offset >= s.start && offset < s.end);
	}

	const cteRanges = buildCteRanges(tokens, source);

	function frameName(line: number): string {
		for (const r of cteRanges) {
			if (line >= r.startLine && line <= r.endLine) return r.name;
		}
		return '_main_';
	}

	const symbols: SymbolEntry[] = [];
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (inJinja(t.start)) continue;

		let role: string | undefined = TOKEN_ROLE_MAP[t.type];
		if (role === undefined) {
			if (t.type === 'VAR') {
				const next = tokens[i + 1];
				role = (next && next.type === 'L_PAREN') ? 'fn' : 'ident';
			} else if (t.type === 'NUMBER' || t.type === 'STRING') {
				role = 'lit';
			}
		}
		if (role === undefined) continue;

		const line = t.line;
		const col = t.start - lineStarts[line];
		const endCol = t.col;
		symbols.push({ line, col, endCol, role, frameName: frameName(line) });
	}

	if (symbols.length === 0) return undefined;

	const refMarkers: BridgeRefMarker[] = [];
	const sourceMarkers: BridgeSourceMarker[] = [];
	const macroSpans: BridgeMacroSpan[] = [];

	for (let i = 0; i < jinjaTokens.length; i++) {
		const open = jinjaTokens[i];
		if (open.type !== 'jinja_expression_open' || open.tagEnd === undefined) continue;
		const tagStart = open.start;
		const tagEnd = open.tagEnd;
		const sourceLine = open.line;

		// Scan inside the tag for ref('name') or source('schema', 'table').
		for (let j = i + 1; j < jinjaTokens.length && jinjaTokens[j].start < tagEnd; j++) {
			const id = jinjaTokens[j];
			if (id.type !== 'jinja_identifier') continue;

			if (id.value === 'ref') {
				const lp = jinjaTokens[j + 1];
				const arg = jinjaTokens[j + 2];
				const rp = jinjaTokens[j + 3];
				if (lp?.type === 'jinja_paren_open' && arg?.type === 'jinja_string' && rp?.type === 'jinja_paren_close') {
					refMarkers.push({ name: arg.value, sourceLine, startOffset: tagStart, endOffset: tagEnd });
				}
				break;
			}
			if (id.value === 'source') {
				const lp = jinjaTokens[j + 1];
				const arg1 = jinjaTokens[j + 2];
				const comma = jinjaTokens[j + 3];
				const arg2 = jinjaTokens[j + 4];
				const rp = jinjaTokens[j + 5];
				if (
					lp?.type === 'jinja_paren_open' &&
					arg1?.type === 'jinja_string' &&
					comma?.type === 'jinja_comma' &&
					arg2?.type === 'jinja_string' &&
					rp?.type === 'jinja_paren_close'
				) {
					sourceMarkers.push({
						schema: arg1.value,
						name: arg2.value,
						sourceLine,
						startOffset: tagStart,
						endOffset: tagEnd,
					});
				}
				break;
			}
		}
	}

	for (const tag of iterJinjaTags(source)) {
		const tagText = tag[0];
		if (!tagText.startsWith('{{')) continue;
		if (REF_TAG_RE.test(tagText) || SOURCE_TAG_RE.test(tagText)) continue;
		const m = MACRO_NAME_RE.exec(tagText);
		if (!m) continue;
		const name = m[1];
		if (STATEMENT_MACROS.has(name) || VALUE_MACROS.has(name)) continue;
		const tagStart = tag.index;
		macroSpans.push({
			name,
			sourceLine: lineAtOffset(tagStart, lineStarts),
			startOffset: tagStart,
			endOffset: tagStart + tagText.length,
		});
	}

	const annotatedSource = injectMarkers(source, symbols, jinjaSpans, { macroSpans, refMarkers, sourceMarkers });
	return { annotatedSource, symbols, macroSpans, refMarkers, sourceMarkers };
}

export interface BridgeMacroSpan {
	name: string;
	sourceLine: number;
	startOffset: number;
	endOffset: number;
}

export interface BridgeRefMarker {
	name: string;
	sourceLine: number;
	startOffset: number;
	endOffset: number;
}

export interface BridgeSourceMarker {
	schema: string;
	name: string;
	sourceLine: number;
	startOffset: number;
	endOffset: number;
}

export interface EmitResult {
	annotatedSource: string;
	symbols: SymbolEntry[];
	macroSpans: BridgeMacroSpan[];
	refMarkers: BridgeRefMarker[];
	sourceMarkers: BridgeSourceMarker[];
}

