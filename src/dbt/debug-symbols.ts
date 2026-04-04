export interface SymbolEntry {
	line: number;
	col: number;
	endCol: number;
	role: string;
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
}

export interface SourceMap {
	mappings: SourceMapping[];
	sourceToCompiled(line: number): SourceMapping[];
	compiledToSource(line: number): SourceMapping[];
	/**
	 * Dense mapping for compiled SQL lines that contain SQL text.
	 * Returns undefined for blank/marker-only lines.
	 */
	compiledLineToSourceLine(compiledLine: number): number | undefined;
	/** Given a compiled line, return the best-guess source line.
	 *  Exact match if available, otherwise interpolates from the nearest mapped line. */
	nearestSourceLine(compiledLine: number): number | undefined;
}

const MARKER_OPEN_RE = /\/\* @dbg:L(\d+):C(\d+):(\w+) \*\//g;
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

export function injectMarkers(
	source: string,
	symbols: SymbolEntry[],
	jinjaSpans: JinjaSpan[],
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

	// Filter + compute char offsets, then sort descending for right-to-left insertion
	const entries = symbols
		.map(s => ({
			startOffset: toOffset(s.line, s.col),
			endOffset: toOffset(s.line, s.endCol),
			marker: `/* @dbg:L${s.line}:C${s.col}:${s.role} */`,
		}))
		.filter(e => !inJinja(e.startOffset))
		.sort((a, b) => b.startOffset - a.startOffset);

	let result = source;
	for (const e of entries) {
		// Insert close marker AFTER the token, open marker BEFORE the token
		// Right-to-left: close first (higher offset), then open
		result = result.slice(0, e.endOffset) + ' /* /@dbg */' + result.slice(e.endOffset);
		result = result.slice(0, e.startOffset) + e.marker + ' ' + result.slice(e.startOffset);
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
	const openRe = /\/\* @dbg:L(\d+):C(\d+):(\w+) \*\//g;
	const closeRe = /\/\* \/@dbg \*\//g;
	let openMatch: RegExpExecArray | null;

	while ((openMatch = openRe.exec(compiledSql)) !== null) {
		const sourceLine = parseInt(openMatch[1], 10);
		const sourceCol = parseInt(openMatch[2], 10);
		const role = openMatch[3];

		// The compiled content starts right after the open marker + space
		const contentStart = openMatch.index + openMatch[0].length + 1;

		// Find the next close marker after this open marker
		closeRe.lastIndex = contentStart;
		const closeMatch = closeRe.exec(compiledSql);
		if (!closeMatch) continue;

		// Content ends at the space before the close marker
		const contentEnd = closeMatch.index - 1;

		mappings.push({
			sourceLine,
			sourceCol,
			compiledLine: offsetToLine(contentStart),
			compiledCol: offsetToCol(contentStart),
			compiledEndLine: offsetToLine(contentEnd),
			compiledEndCol: offsetToCol(contentEnd),
			role,
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

	// Pre-sort by compiledLine for binary-search interpolation
	const sortedByCompiled = [...mappings].sort((a, b) => a.compiledLine - b.compiledLine);

	function nearestInterpolated(compiledLine: number): number | undefined {
		if (sortedByCompiled.length === 0) return undefined;
		const exact = byCompiledLine.get(compiledLine);
		if (exact && exact.length > 0) return exact[0].sourceLine;

		// Binary search for nearest mapped compiled line
		let lo = 0;
		let hi = sortedByCompiled.length - 1;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (sortedByCompiled[mid].compiledLine < compiledLine) lo = mid + 1;
			else hi = mid;
		}
		let best = sortedByCompiled[lo];
		if (lo > 0) {
			const prev = sortedByCompiled[lo - 1];
			if (Math.abs(prev.compiledLine - compiledLine) < Math.abs(best.compiledLine - compiledLine)) {
				best = prev;
			}
		}
		// Interpolate: same delta from nearest anchor
		return best.sourceLine + (compiledLine - best.compiledLine);
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
			return nearestInterpolated(compiledLine);
		},
		nearestSourceLine(compiledLine: number): number | undefined {
			return nearestInterpolated(compiledLine);
		},
	};
}

export interface EmitResult {
	annotatedSource: string;
	symbols: SymbolEntry[];
}

export async function emitDebugSymbols(
	source: string,
	dialect: string,
	bridgeInvokeRaw: (request: Record<string, unknown>) => Promise<{ data?: Record<string, unknown> }>,
): Promise<EmitResult | undefined> {
	const result = await bridgeInvokeRaw({
		emit_debug_symbols: true,
		sql: source,
		dialect,
	});

	const symbols = result.data?.['symbols'] as SymbolEntry[] | undefined;
	if (!symbols || symbols.length === 0) return undefined;

	const jinjaSpans = findJinjaSpans(source);
	const annotatedSource = injectMarkers(source, symbols, jinjaSpans);

	return { annotatedSource, symbols };
}
