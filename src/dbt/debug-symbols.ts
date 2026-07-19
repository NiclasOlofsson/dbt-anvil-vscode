import { buildLineStarts } from '../ftl/line-index';
import { minijinja, SqlDocument, tokenize, toSqllensDialect, MAIN_FRAME } from '../ftl/sqllens/api';
import type { Sym, Dialect, ScopeTree, TagNode, TemplateProvider } from '../ftl/sqllens/api';
import { allScopes, asCst } from '../ftl/sqllens/extract/spans';
import { emittedTagKind, NOT_MACRO_CALLS } from '../ftl/sqllens/extract/tag-infos';
import { DBT_PROVIDER } from '../ftl/sqllens/template-shape';

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

/**
 * Extract @ref / @source / @macro Jinja classifications from the tag-AST.
 * The Jinja marker wire format is independent of the symbol emit pass.
 *
 * ref/source detection shares `emittedTagKind` with tag-infos.ts, so the
 * debugger and the language providers never disagree on what counts as a
 * confirmed reference (covers `ref('pkg','model')` and `ref(model=…)`, which
 * the retired jinja-token scan silently dropped). A macro is any closed call
 * whose callee is not in NOT_MACRO_CALLS; `name` is the top-level callee.
 */
function buildJinjaClassifications(
	tags: TagNode[],
): { refMarkers: BridgeRefMarker[]; sourceMarkers: BridgeSourceMarker[]; macroSpans: BridgeMacroSpan[] } {
	const refMarkers: BridgeRefMarker[] = [];
	const sourceMarkers: BridgeSourceMarker[] = [];
	const macroSpans: BridgeMacroSpan[] = [];

	for (const tag of tags) {
		if (tag.kind !== 'call') continue;
		const emitted = emittedTagKind(tag);
		if (emitted === 'ref') {
			// dbt: the model is the LAST positional arg (or `model=`).
			const arg = tag.args[tag.args.length - 1]!;
			refMarkers.push({
				name: arg.value!,
				sourceLine: tag.tagSpan.line - 1,
				startOffset: tag.tagSpan.start,
				endOffset: tag.tagSpan.end,
			});
			continue;
		}
		if (emitted === 'source') {
			const src = tag.args[0]!;
			const tbl = tag.args[1]!;
			sourceMarkers.push({
				schema: src.value!,
				name: tbl.value!,
				sourceLine: tag.tagSpan.line - 1,
				startOffset: tag.tagSpan.start,
				endOffset: tag.tagSpan.end,
			});
			continue;
		}
		if (tag.incomplete || NOT_MACRO_CALLS.has(tag.name)) continue;
		macroSpans.push({
			name: tag.name,
			sourceLine: tag.tagSpan.line - 1,
			startOffset: tag.tagSpan.start,
			endOffset: tag.tagSpan.end,
		});
	}

	return { refMarkers, sourceMarkers, macroSpans };
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

// ---------------------------------------------------------------------------
// emitDebugSymbols — sqllens-powered emit path (parallel to
// emitDebugSymbolsFromTokens). Symbols come from sqllens's semantic Sym model
// (idents/functions) plus its lexical token stream (clause keywords / star /
// literals); frames come from Sym.frame, replacing the hand-rolled
// buildCteRanges walk. The marker WIRE FORMAT is identical — injectMarkers /
// parseSourceMap are reused unchanged.
// ---------------------------------------------------------------------------

/** Clause-keyword text (uppercased) → debugger role. The sqllens analogue of
 *  TOKEN_ROLE_MAP: sqllens emits GROUP/ORDER/… as separate keyword tokens (not
 *  collapsed forms like GROUP_BY/ORDER_BY), so we key the *leading* keyword —
 *  its line is the one the debugger anchors the clause to. */
const CLAUSE_KEYWORD_ROLE: Record<string, string> = {
	SELECT: 'select',
	FROM: 'from',
	JOIN: 'join',
	INNER: 'join',
	LEFT: 'join',
	RIGHT: 'join',
	CROSS: 'join',
	FULL: 'join',
	WHERE: 'where',
	GROUP: 'group',
	HAVING: 'having',
	ORDER: 'order',
	LIMIT: 'limit',
	SORT: 'sort',
	CLUSTER: 'cluster',
	DISTRIBUTE: 'distribute',
	OFFSET: 'offset',
	WITH: 'cte',
};

interface FrameRange {
	name: string;
	/** 0-based inclusive line bounds. */
	startLine: number;
	endLine: number;
}

/** Each CTE's whole-clause (`name AS (body)`) 0-based line bounds, read straight off
 *  the CST rather than a declaration Sym's own `span` — sqllens (commit 04f9727) now
 *  anchors a declaration Sym's span at just the name identifier, not the whole clause,
 *  so it can no longer bound a CTE body that carries no other Sym-bearing content of
 *  its own (e.g. a bare unaliased literal projection: `with x as (select 1) ...`
 *  produces zero column Syms inside `x`'s frame). `buildFrameRanges` needs the WHOLE
 *  clause for that case. Keyed by the declaration's own start position (`line:column`,
 *  the same 1-based-line/0-based-column pair `Sym.span` uses) rather than by name —
 *  a CTE's `Sym.name` is `displayName`-derived and isn't guaranteed to match
 *  `CteDef.name`'s raw spelling, and a name-string key risks the same identity bug
 *  this codebase has hit before with CTEs (see sym-spans.ts's `cteAnchorOf`). The
 *  declaration's own span always starts at the same position as the whole clause
 *  (the name is the first thing in it), so this always finds an entry — verified
 *  empirically. */
function cteWholeClauseLineBounds(scopes: ScopeTree): Map<string, { start: number; end: number }> {
	const bounds = new Map<string, { start: number; end: number }>();
	for (const scope of allScopes(scopes)) {
		for (const [, cteRef] of scope.ctes) {
			const c = asCst(cteRef.def.cst);
			if (!c.start || !c.stop) continue;
			bounds.set(`${c.start.line}:${c.start.column}`, { start: c.start.line - 1, end: c.stop.line - 1 });
		}
	}
	return bounds;
}

/** Per-frame line ranges derived from Sym.frame. A symbol's own frame bounds that
 *  frame; a CTE *declaration* additionally bounds the frame it names, using the
 *  whole clause's bounds (`cteBodyBounds`) rather than the declaration Sym's own
 *  (now name-only) span — see `cteWholeClauseLineBounds`'s doc comment.
 *  Used only to attribute token-derived roles (keywords/star/literals) to a
 *  frame — ident/fn symbols carry Sym.frame directly. */
function buildFrameRanges(symbols: Sym[], cteBodyBounds: Map<string, { start: number; end: number }>): FrameRange[] {
	const map = new Map<string, { start: number; end: number }>();
	const fold = (name: string, l0: number, l1: number): void => {
		if (name === MAIN_FRAME) return; // _main_ is the fallback; never a bounded range
		const cur = map.get(name);
		if (cur) {
			cur.start = Math.min(cur.start, l0);
			cur.end = Math.max(cur.end, l1);
		} else {
			map.set(name, { start: l0, end: l1 });
		}
	};
	for (const s of symbols) {
		const l0 = s.span.line - 1;
		const l1 = s.span.endLine - 1;
		fold(s.frame, l0, l1);
		if (s.kind === 'cte' && s.modifiers.includes('declaration')) {
			const wholeClause = cteBodyBounds.get(`${s.span.line}:${s.span.column}`);
			fold(s.name, wholeClause ? wholeClause.start : l0, wholeClause ? wholeClause.end : l1);
		}
	}
	return [...map].map(([name, r]) => ({ name, startLine: r.start, endLine: r.end }));
}

/** The narrowest (innermost) frame whose range covers `line`, else _main_. */
function resolveFrame(line: number, ranges: FrameRange[]): string {
	let best: FrameRange | undefined;
	for (const r of ranges) {
		if (line >= r.startLine && line <= r.endLine) {
			if (!best || r.endLine - r.startLine < best.endLine - best.startLine) best = r;
		}
	}
	return best ? best.name : MAIN_FRAME;
}

/** One engine instance, mirroring document-parser.ts's MINIJINJA: a stateless
 *  strategy object sqllens keys its cell cache on by name, so a module singleton
 *  keeps that key stable. */
const MINIJINJA = minijinja();

/** Run sqllens's templated front end through the full SqlDocument door (the same
 *  one the language providers use), so symbols come from `unionSymbols()` — idents
 *  and functions across EVERY branch/loop arm, deduped — rather than the single
 *  primary realization. dbt compiles exactly one arm; whichever it is, that arm's
 *  ident markers are now present. The keyword/star/lit path (tokenize(placeholder))
 *  was already all-arms since the placeholder is the length-preserving all-text-live
 *  fill. `tags`/`placeholder`/`tokens` ride on `doc.templated`, so this stays one
 *  parse. Error-tolerant: a partial parse still yields symbols for what parsed. */
function analyzeTemplated(
	source: string,
	dialect: Dialect,
	provider: TemplateProvider,
): { symbols: Sym[]; blanked: string; tags: TagNode[]; cteBodyBounds: Map<string, { start: number; end: number }> } | undefined {
	try {
		const doc = SqlDocument.create(source, dialect, { templating: MINIJINJA, provider });
		const templated = doc.templated;
		if (!templated) return undefined;
		return {
			symbols: doc.unionSymbols(),
			blanked: templated.placeholder,
			tags: templated.tags,
			cteBodyBounds: cteWholeClauseLineBounds(doc.scopes),
		};
	} catch {
		// Preserve the old failure contract: the caller's undefined arm falls
		// back to a plain (marker-less) compile.
		return undefined;
	}
}

/**
 * The PRODUCTION emit path (debug-adapter.ts) — fully sqllens-fed, no legacy
 * parse anywhere: symbols, jinja stream, and tag classifications all come from
 * ONE parseTemplated run. Emits the same SymbolEntry[] / EmitResult the token
 * path produced — injectMarkers, parseSourceMap, and the @dbg wire format are
 * shared and unchanged, so compile-survival is identical.
 *
 * Roles: idents (column reference / table / alias / cte) and functions come from
 * the semantic Sym model; clause keywords, `*`, and literals come from the
 * lexical token stream. Frames come from Sym.frame (idents/fns) or a frame-range
 * lookup keyed on Sym.frame (token-derived roles).
 */
export function emitDebugSymbols(
	source: string,
	dialect: string | undefined,
	provider: TemplateProvider = DBT_PROVIDER,
): EmitResult | undefined {
	const sqllensDialect = toSqllensDialect(dialect);
	const analyzed = analyzeTemplated(source, sqllensDialect, provider);
	if (!analyzed) return undefined;
	const { symbols: syms, blanked, tags, cteBodyBounds } = analyzed;

	const lineStarts = buildLineStarts(source);
	// Marker-exclusion regions straight off the tag-AST (the old private
	// findJinjaSpans re-scan is token-path-only now).
	const jinjaSpans: JinjaSpan[] = tags.map(t => ({ start: t.tagSpan.start, end: t.tagSpan.end }));
	const inJinja = (offset: number): boolean => jinjaSpans.some(s => offset >= s.start && offset < s.end);
	const frameRanges = buildFrameRanges(syms, cteBodyBounds);

	// Candidate markers carry char offsets so we can drop any that overlap a kept
	// one — injectMarkers assumes disjoint, single-line spans (it splices markers
	// right-to-left and nested/overlapping insertions would corrupt the offsets).
	interface Candidate {
		line: number;
		col: number;
		endCol: number;
		role: string;
		frameName: string;
		startOffset: number;
		endOffset: number;
	}
	const candidates: Candidate[] = [];
	const push = (line: number, col: number, endCol: number, role: string, frameName: string): void => {
		if (endCol <= col) return;
		const base = lineStarts[line] ?? 0;
		const startOffset = base + col;
		if (inJinja(startOffset)) return; // Jinja-region symbols (e.g. a blanked ref table name) are skipped
		candidates.push({ line, col, endCol, role, frameName, startOffset, endOffset: base + endCol });
	};

	// Idents + functions from the semantic Sym model. Each carries its own frame.
	for (const s of syms) {
		const line = s.span.line - 1;
		const col = s.span.column;
		const nameEnd = col + s.name.length;
		// A single-line span uses its exact end column; a wide/multi-line span falls
		// back to the name width to stay single-line and narrow (injectMarkers needs
		// start and end on the same line).
		const sameLineEnd = s.span.endLine === s.span.line && s.span.endColumn > col ? s.span.endColumn : nameEnd;
		let role: string | undefined;
		let endCol = sameLineEnd;
		switch (s.kind) {
			case 'function':
				role = 'fn';
				endCol = nameEnd; // mark only the function name, not the whole call
				break;
			case 'table':
			case 'alias':
				role = 'ident';
				break;
			case 'cte':
				role = 'ident';
				endCol = nameEnd; // a CTE declaration's span may cover the whole body; keep it name-only
				break;
			case 'column':
				// Column references only — output/star declarations have wide spans that
				// overlap their inner refs (the `*` and literals are marked from tokens).
				if (
					s.modifiers.includes('reference') &&
					!s.modifiers.includes('output') &&
					!s.modifiers.includes('star')
				) {
					role = 'ident';
				}
				break;
		}
		if (role === undefined) continue;
		push(line, col, endCol, role, s.frame);
	}

	// Clause keywords, `*`, and literals from the lexical token stream.
	for (const t of tokenize(blanked, sqllensDialect)) {
		if (t.channel !== 0) continue; // skip hidden-channel trivia (comments/whitespace)
		let role: string | undefined;
		if (t.role === 'number' || t.role === 'string') role = 'lit';
		else if (t.text === '*') role = 'star';
		else if (t.role === 'keyword') role = CLAUSE_KEYWORD_ROLE[t.text.toUpperCase()];
		if (role === undefined) continue;
		const line = t.line - 1;
		const col = t.column;
		const nl = t.text.indexOf('\n');
		const endCol = col + (nl === -1 ? t.text.length : nl); // clamp a multi-line literal to its first line
		push(line, col, endCol, role, resolveFrame(line, frameRanges));
	}

	// Sort by start offset and greedily keep a disjoint set (drop overlaps).
	candidates.sort((a, b) => a.startOffset - b.startOffset || a.endOffset - b.endOffset);
	const symbols: SymbolEntry[] = [];
	let lastEnd = -1;
	for (const c of candidates) {
		if (c.startOffset < lastEnd) continue;
		symbols.push({ line: c.line, col: c.col, endCol: c.endCol, role: c.role, frameName: c.frameName });
		lastEnd = c.endOffset;
	}

	if (symbols.length === 0) return undefined;

	const { refMarkers, sourceMarkers, macroSpans } = buildJinjaClassifications(tags);
	const annotatedSource = injectMarkers(source, symbols, jinjaSpans, { macroSpans, refMarkers, sourceMarkers });
	return { annotatedSource, symbols, macroSpans, refMarkers, sourceMarkers };
}

