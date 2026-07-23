import { buildLineStarts } from '../ftl/line-index';
import { minijinja, SqlDocument, toSqllensDialect, MAIN_FRAME } from '../ftl/sqllens/api';
import type { Sym, Dialect, ClauseKind, TagNode, TemplateProvider } from '../ftl/sqllens/api';
import { allScopes } from '../ftl/sqllens/extract/spans';
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

/** sqllens `ClauseKind` → debugger role (the wire vocabulary the stepping UI and
 *  source map speak). `window` is deliberately unmapped: never a pausable anchor
 *  (named windows dissolve into the OVER specs — channel ruling 2026-07-21). */
const CLAUSE_KIND_ROLE: Partial<Record<ClauseKind, string>> = {
	select: 'select',
	from: 'from',
	join: 'join',
	where: 'where',
	groupBy: 'group',
	having: 'having',
	qualify: 'qualify',
	orderBy: 'order',
	limit: 'limit',
};

/** Leading keyword (uppercased) → role, for the anchors `clausesOf` does not
 *  model yet: WITH (the CTE section), OFFSET, and Spark's SORT/CLUSTER/DISTRIBUTE
 *  BY. Marked from the templated token stream; retire entries as ClauseKind
 *  grows. */
const RESIDUAL_KEYWORD_ROLE: Record<string, string> = {
	WITH: 'cte',
	OFFSET: 'offset',
	SORT: 'sort',
	CLUSTER: 'cluster',
	DISTRIBUTE: 'distribute',
};

/** One engine instance, mirroring document-parser.ts's MINIJINJA: a stateless
 *  strategy object sqllens keys its cell cache on by name, so a module singleton
 *  keeps that key stable. */
const MINIJINJA = minijinja();

/** Run sqllens's templated front end through the full SqlDocument door (the same
 *  one the language providers use), so symbols come from `unionSymbols()` — idents
 *  and functions across EVERY branch/loop arm, deduped — rather than the single
 *  primary realization. dbt compiles exactly one arm; whichever it is, that arm's
 *  ident markers are now present. The doc itself rides along: clause anchors come
 *  from its `clausesOf` view (per arm), residual keywords / star / literals from
 *  `doc.templated.tokens` (the all-arms placeholder stream), frames from `frameAt`
 *  — one parse, nothing re-lexed. Error-tolerant: a partial parse still yields
 *  symbols for what parsed. */
function analyzeTemplated(
	source: string,
	dialect: Dialect,
	provider: TemplateProvider,
): { doc: SqlDocument; symbols: Sym[]; tags: TagNode[] } | undefined {
	try {
		const doc = SqlDocument.create(source, dialect, { templating: MINIJINJA, provider });
		const templated = doc.templated;
		if (!templated) return undefined;
		return { doc, symbols: doc.unionSymbols(), tags: templated.tags };
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
 * the semantic Sym model; clause anchors come from sqllens's `clausesOf` view
 * (per arm); residual keywords, `*`, and literals from the templated token
 * stream. Frames come from Sym.frame (idents/fns) or `frameAt` (token-derived
 * roles) — the two agree by construction.
 */
export function emitDebugSymbols(
	source: string,
	dialect: string | undefined,
	provider: TemplateProvider = DBT_PROVIDER,
): EmitResult | undefined {
	const sqllensDialect = toSqllensDialect(dialect);
	const analyzed = analyzeTemplated(source, sqllensDialect, provider);
	if (!analyzed) return undefined;
	const { doc, symbols: syms, tags } = analyzed;

	const lineStarts = buildLineStarts(source);
	// Marker-exclusion regions straight off the tag-AST (the old private
	// findJinjaSpans re-scan is token-path-only now).
	const jinjaSpans: JinjaSpan[] = tags.map(t => ({ start: t.tagSpan.start, end: t.tagSpan.end }));
	const inJinja = (offset: number): boolean => jinjaSpans.some(s => offset >= s.start && offset < s.end);

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

	// Frame attribution for token-derived roles: sqllens's own owner-of-offset
	// answer, agreeing with Sym.frame by construction. Off-construct → _main_.
	const frameOf = (d: SqlDocument, offset: number): string => d.frameAt(offset)?.frame ?? MAIN_FRAME;

	// Clause anchors from the structural clause view, walked per arm (a dbt
	// `{% else %}` arm carries clauses the primary realization does not).
	// Realizations are coordinate-preserving, so cross-arm duplicates share a
	// start offset and dedupe on it. anchorSpan covers the whole keyword run
	// (`group by`, `left join`), clamped to its first line for injectMarkers.
	const seenAnchors = new Set<number>();
	for (const armDoc of [doc, ...doc.variants.map(v => v.doc())]) {
		for (const scope of allScopes(armDoc.scopes)) {
			for (const clause of armDoc.clausesOf(scope)) {
				const role = CLAUSE_KIND_ROLE[clause.kind];
				if (role === undefined || seenAnchors.has(clause.anchorSpan.start)) continue;
				seenAnchors.add(clause.anchorSpan.start);
				const line = clause.anchorSpan.line - 1;
				const lineEnd = (lineStarts[line + 1] ?? source.length + 1) - 1;
				const endCol = clause.anchorSpan.endLine === clause.anchorSpan.line
					? clause.anchorSpan.endColumn
					: lineEnd - (lineStarts[line] ?? 0);
				push(line, clause.anchorSpan.column, endCol, role, frameOf(armDoc, clause.anchorSpan.start));
			}
		}
	}

	// Residual keywords (kinds clausesOf does not model yet), `*`, and literals
	// from the templated token stream — the all-arms placeholder lex the parse
	// already carries; nothing is re-tokenized.
	for (const t of doc.templated!.tokens) {
		if (t.channel !== 0) continue; // skip hidden-channel trivia (comments/whitespace)
		let role: string | undefined;
		if (t.role === 'number' || t.role === 'string') role = 'lit';
		else if (t.text === '*') role = 'star';
		else if (t.role === 'keyword') role = RESIDUAL_KEYWORD_ROLE[t.text.toUpperCase()];
		if (role === undefined) continue;
		const line = t.line - 1;
		const col = t.column;
		const nl = t.text.indexOf('\n');
		const endCol = col + (nl === -1 ? t.text.length : nl); // clamp a multi-line literal to its first line
		push(line, col, endCol, role, frameOf(doc, t.start));
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

