// ==============================================================================
// DECOMPOSE QUERY (sqllens / native TS)
//
// Pure-TS reimplementation of resources/ftl/sql_parser.py `_decompose_query`.
// It slices debug frames (CTEs + `_main_`) and per-frame stage clauses out of
// COMPILED SQL (dbt-compiled output — no jinja).
//
// Difference from the Python original: the Python version regenerates each stage
// via sqlglot's SQL generator. This version slices the ORIGINAL source text at IR
// node spans, so every stage keeps the user's exact formatting verbatim (a
// weirdly-spaced identifier survives). Because the input carries no jinja, slicing
// the original text is both faithful and cheaper than re-emitting.
//
// The output shape is JSON-identical to the Python contract consumed by
// src/dbt/debug-adapter.ts: { success, frames[], clauses{}, refs{} } with 0-based
// line numbers. Callers still receive a JSON string today — the seam does
// `JSON.stringify(decompose(...))`; this module returns the typed object.
// ==============================================================================

import { parse, type CteDef, type Dialect, type QueryBody, type QueryExpr, type SelectExpr, type SetOpExpr, type Source, type Token } from 'sqllens';

// ── Output contract (mirrors debug-adapter.ts DecomposeFrame / DecomposeClause) ──

export interface DecomposeFrame {
	name: string;
	type: 'cte' | 'select';
	/** 0-based line where the frame starts. */
	line: number;
	/** 0-based line where the frame ends. */
	endLine: number;
}

export interface DecomposeClause {
	stage: string;
	/** A runnable standalone query for this stage (starts with SELECT/WITH), or '' for
	 *  marker-only stages (qualify) that the Python original also leaves empty. */
	sql: string;
	/** 0-based line of the stage's leading keyword in the compiled SQL. */
	line: number;
	/** Position of this clause in the frame's stage list. */
	order: number;
	/** 1-based UNION leg position, when the frame body is a UNION. Absent otherwise. */
	union_leg?: number;
	/** Total UNION legs at the frame level. Pairs with union_leg. */
	union_total?: number;
}

export interface DecomposeResult {
	success: boolean;
	error?: string;
	frames: DecomposeFrame[];
	clauses: Record<string, DecomposeClause[]>;
	refs: Record<string, string[]>;
}

// ── Minimal view of the ANTLR CST token span carried on every IR node's `cst`.
//    Declared locally so this module does not depend on antlr4ng's types. antlr
//    char offsets are 0-based inclusive; `line` is 1-based, `column` 0-based. ──

interface SrcToken {
	start: number;
	stop: number;
	line: number;
	column: number;
	text: string;
}
interface Cst {
	start: SrcToken | null;
	stop: SrcToken | null;
}

interface Spanned {
	cst: unknown;
}

function cstOf(node: Spanned): Cst {
	return node.cst as Cst;
}

/** 0-based inclusive start char offset of a node. */
function startOffset(node: Spanned): number {
	return cstOf(node).start?.start ?? 0;
}

/** 0-based inclusive stop char offset of a node. */
function stopOffset(node: Spanned): number {
	return cstOf(node).stop?.stop ?? startOffset(node);
}

/** 0-based line the node starts on. */
function startLine0(node: Spanned): number {
	return Math.max(0, (cstOf(node).start?.line ?? 1) - 1);
}

/** 0-based line the node ends on. */
function stopLine0(node: Spanned): number {
	return Math.max(0, (cstOf(node).stop?.line ?? 1) - 1);
}

/**
 * The clause keyword token immediately preceding `contentStart` and belonging to
 * this select level. Keywords sit right before their content (only whitespace /
 * comments between), so the matching-name token with the largest `start` that is
 * still before the content — and no earlier than the select's own start — is the
 * top-level keyword. A nested subquery's same-named keyword is always further from
 * the content start, so it never wins.
 */
function keywordBefore(tokens: Token[], name: string, contentStart: number, lowerBound: number): Token | undefined {
	let best: Token | undefined;
	for (const t of tokens) {
		if (t.name.toUpperCase() !== name) continue;
		if (t.start >= contentStart || t.start < lowerBound) continue;
		if (!best || t.start > best.start) best = t;
	}
	return best;
}

/** Preceding CTE definitions for a frame — every CTE declared before `name`
 *  (all CTEs for `_main_`). These become the WITH prefix of a runnable stage. */
function precedingCtes(ctes: readonly CteDef[], name: string): CteDef[] {
	const out: CteDef[] = [];
	for (const c of ctes) {
		if (c.name === name && name !== '_main_') break;
		out.push(c);
	}
	return out;
}

/** Prepend `WITH <preceding CTE defs>` so a mid-pipeline stage runs standalone. */
function withPrefix(sql: string, prefixCtes: CteDef[], rawSql: string): string {
	if (prefixCtes.length === 0) return sql;
	const parts = prefixCtes.map(c => rawSql.slice(startOffset(c), stopOffset(c) + 1));
	return `WITH ${parts.join(', ')}\n${sql}`;
}

/** Flatten a (possibly nested) set-op into its SELECT legs, left-to-right — the
 *  source order the Python `_collect_union_selects` produces. */
function collectLegs(body: QueryBody): SelectExpr[] {
	if (body.kind === 'setop') return [...collectLegs(body.left), ...collectLegs(body.right)];
	if (body.kind === 'select') return [body];
	return [];
}

/** Top-level FROM/JOIN target names for a frame, in declaration order. The debug
 *  adapter indexes these positionally against the frame's from/join stages, so
 *  there is exactly one entry per top-level source (base first, then joined). */
function tableRefs(body: QueryBody): string[] {
	const refs: string[] = [];
	const visitSelect = (sel: SelectExpr): void => {
		for (const src of sel.from) refs.push(sourceName(src));
	};
	if (body.kind === 'select') visitSelect(body);
	else if (body.kind === 'setop') for (const leg of collectLegs(body)) visitSelect(leg);
	return refs;
}

function sourceName(src: Source): string {
	switch (src.kind) {
		case 'table':
			return src.name[src.name.length - 1] ?? '';
		case 'subquery':
			// No table name; the alias is the closest step-in handle. Falls back to the
			// first inner table so lineage still resolves when unaliased.
			return src.alias ?? tableRefs(src.query.body)[0] ?? '';
		case 'lateral':
			return src.alias ?? '';
		case 'graphtable':
			return src.graph[src.graph.length - 1] ?? '';
	}
}

// ── Stage construction context ──

interface StageCtx {
	sql: string;
	tokens: Token[];
	prefixCtes: CteDef[];
	/** QueryExpr-level ORDER BY (sqllens models it on QueryExpr, not SelectExpr). */
	orderBy?: readonly unknown[];
	/** QueryExpr-level LIMIT / OFFSET. */
	limit?: { top?: unknown; offset?: unknown };
	/** Span [start, stop] of the full runnable text for the select / order / limit stages. */
	fullTextStart: number;
	fullTextStop: number;
}

/**
 * TODO(sqllens-join): populate once Join IR nodes with spans land (Phase 0).
 *
 * sqllens does not yet model joins as nodes — a SelectExpr carries `from: Source[]`
 * (base + joined tables, flattened) plus detached `joinConditions`, with the JOIN
 * keywords / types living only in the raw text between sources. Until a Join node
 * with its own span exists there is no faithful per-join boundary to slice, so this
 * returns no join stages. The from / where / group / having stages stay correct
 * regardless: they slice the CONTIGUOUS source region (see buildSelectClauses), which
 * already contains the join text.
 */
function joinStages(_sel: SelectExpr, _sql: string): DecomposeClause[] {
	return [];
}

/**
 * Build the ordered stage clauses for one SELECT.
 *
 * Contiguous-region strategy (the deliberate divergence from the Python original):
 * because joins are not IR nodes yet, stages that in Python concatenate FROM + joins
 * + WHERE from regenerated fragments instead slice ONE contiguous span of the original
 * text — FROM-keyword → end-of-clause — which necessarily contains any join text
 * sitting between FROM and the next clause. This sidesteps the missing Join nodes and
 * is more faithful (exact source, joins included) than reassembling fragments.
 */
function buildSelectClauses(sel: SelectExpr, ctx: StageCtx): DecomposeClause[] {
	const { sql, tokens, prefixCtes } = ctx;
	const clauses: Array<Omit<DecomposeClause, 'order'>> = [];
	const selStart = startOffset(sel);

	const projStart = sel.projections[0] ? startOffset(sel.projections[0]) : selStart;
	const selectTok = keywordBefore(tokens, 'SELECT', projStart, selStart);
	const selectKwOff = selectTok ? selectTok.start : selStart;
	const selectKwLine = selectTok ? selectTok.line - 1 : startLine0(sel);

	const hasFrom = sel.from.length > 0;
	const fromContentStart = hasFrom ? startOffset(sel.from[0]) : selStart;
	const fromTok = hasFrom ? keywordBefore(tokens, 'FROM', fromContentStart, selStart) : undefined;
	const fromKwOff = fromTok ? fromTok.start : fromContentStart;
	const fromKwLine = fromTok ? fromTok.line - 1 : startLine0(sel);
	// End of the from+joins region = the last positioned token of the FROM clause:
	// the furthest source stop OR the furthest join-condition stop (ON preds come
	// after their joined relation).
	let fromContentEnd = fromKwOff;
	for (const s of sel.from) fromContentEnd = Math.max(fromContentEnd, stopOffset(s));
	for (const j of sel.joinConditions ?? []) fromContentEnd = Math.max(fromContentEnd, stopOffset(j as Spanned));

	// Present later clauses (in source order) with their keyword token + content end.
	const whereClause = sel.where
		? clauseAnchor(tokens, 'WHERE', sel.where as Spanned, selStart)
		: undefined;
	const groupClause = sel.groupBy && sel.groupBy.length > 0
		? clauseAnchorList(tokens, 'GROUP', sel.groupBy as Spanned[], selStart)
		: undefined;
	const havingClause = sel.having
		? clauseAnchor(tokens, 'HAVING', sel.having as Spanned, selStart)
		: undefined;
	const qualifyClause = sel.qualify
		? clauseAnchor(tokens, 'QUALIFY', sel.qualify as Spanned, selStart)
		: undefined;
	const orderClause = ctx.orderBy && ctx.orderBy.length > 0
		? clauseAnchorList(tokens, 'ORDER', ctx.orderBy as Spanned[], selStart)
		: undefined;
	const limitTok = ctx.limit && (ctx.limit.top !== undefined || ctx.limit.offset !== undefined)
		? keywordBefore(tokens, ctx.limit.top !== undefined ? 'LIMIT' : 'OFFSET', ctx.fullTextStop + 1, selStart)
		: undefined;

	// Right edge of the from stage: the first later-clause keyword, else end of the
	// from region. (The from stage keeps joins — see joinStages seam docs.)
	const laterKwStarts = [whereClause?.kwOff, groupClause?.kwOff, havingClause?.kwOff, qualifyClause?.kwOff, orderClause?.kwOff, limitTok?.start]
		.filter((n): n is number => n !== undefined && n > fromKwOff);
	const fromRegionEnd = laterKwStarts.length > 0 ? Math.min(...laterKwStarts) : fromContentEnd + 1;

	// Full runnable text for select / order / limit. If it already opens with WITH
	// (e.g. `_main_`, whose span covers the leading CTEs), do not double-prefix.
	const fullText = sql.slice(ctx.fullTextStart, ctx.fullTextStop + 1);
	const fullSql = /^\s*with\b/i.test(fullText) ? fullText : withPrefix(fullText, prefixCtes, sql);

	// 1. FROM (+ joins, via the contiguous slice).
	if (hasFrom) {
		clauses.push({
			stage: 'from',
			sql: withPrefix(`SELECT * ${sql.slice(fromKwOff, fromRegionEnd).trimEnd()}`, prefixCtes, sql),
			line: fromKwLine,
		});
	}

	// 2. JOIN stages — empty until Join IR lands (seam).
	clauses.push(...joinStages(sel, sql).map(c => ({ stage: c.stage, sql: c.sql, line: c.line })));

	// 3. WHERE — contiguous FROM..WHERE (includes join text).
	if (whereClause && hasFrom) {
		clauses.push({
			stage: 'where',
			sql: withPrefix(`SELECT * ${sql.slice(fromKwOff, whereClause.contentEnd + 1).trimEnd()}`, prefixCtes, sql),
			line: whereClause.kwLine,
		});
	}

	// 4. GROUP BY — contiguous SELECT..GROUP (real projections + from + joins + where).
	if (groupClause && hasFrom) {
		clauses.push({
			stage: 'group',
			sql: withPrefix(sql.slice(selectKwOff, groupClause.contentEnd + 1).trimEnd(), prefixCtes, sql),
			line: groupClause.kwLine,
		});
	}

	// 5. HAVING — contiguous SELECT..HAVING.
	if (havingClause && groupClause && hasFrom) {
		clauses.push({
			stage: 'having',
			sql: withPrefix(sql.slice(selectKwOff, havingClause.contentEnd + 1).trimEnd(), prefixCtes, sql),
			line: havingClause.kwLine,
		});
	}

	// 6. QUALIFY — marker only (empty sql), matching the Python original.
	if (qualifyClause) {
		clauses.push({ stage: 'qualify', sql: '', line: qualifyClause.kwLine });
	}

	// 7. SELECT — the full runnable query.
	clauses.push({ stage: 'select', sql: fullSql, line: selectKwLine });

	// 8. ORDER BY — same full query; keyword line points at ORDER.
	if (orderClause && hasFrom) {
		clauses.push({ stage: 'order', sql: fullSql, line: orderClause.kwLine });
	}

	// 9. LIMIT / OFFSET — same full query.
	if (limitTok) {
		clauses.push({ stage: 'limit', sql: fullSql, line: limitTok.line - 1 });
	}

	return clauses.map((c, order) => ({ ...c, order }));
}

interface ClauseAnchor {
	kwOff: number;
	kwLine: number;
	contentEnd: number;
}

function clauseAnchor(tokens: Token[], name: string, content: Spanned, selStart: number): ClauseAnchor {
	const tok = keywordBefore(tokens, name, startOffset(content), selStart);
	return {
		kwOff: tok ? tok.start : startOffset(content),
		kwLine: tok ? tok.line - 1 : startLine0(content),
		contentEnd: stopOffset(content),
	};
}

function clauseAnchorList(tokens: Token[], name: string, contents: Spanned[], selStart: number): ClauseAnchor {
	const first = contents[0];
	const tok = keywordBefore(tokens, name, startOffset(first), selStart);
	let end = stopOffset(first);
	for (const c of contents) end = Math.max(end, stopOffset(c));
	return {
		kwOff: tok ? tok.start : startOffset(first),
		kwLine: tok ? tok.line - 1 : startLine0(first),
		contentEnd: end,
	};
}

/** Clauses for a frame body — a plain SELECT, or a UNION whose legs are flattened
 *  and tagged (union_leg / union_total) so the debug adapter can disambiguate
 *  same-stage clauses across branches. Mirrors the Python `extract_clauses`. */
function extractClauses(body: QueryBody, ctx: Omit<StageCtx, 'orderBy' | 'limit' | 'fullTextStart' | 'fullTextStop'>, qe: QueryExpr): DecomposeClause[] {
	if (body.kind === 'setop') return extractSetopClauses(body, ctx);

	if (body.kind === 'select') {
		return buildSelectClauses(body, {
			...ctx,
			orderBy: qe.orderBy,
			limit: qe.limit,
			fullTextStart: startOffset(qe),
			fullTextStop: stopOffset(qe),
		});
	}

	// PipeExpr / anything else: a single select stage over the whole text — the
	// Python original only handled Select/Union, so this is a conservative fallback.
	const fullText = ctx.sql.slice(startOffset(qe), stopOffset(qe) + 1);
	const fullSql = /^\s*with\b/i.test(fullText) ? fullText : withPrefix(fullText, ctx.prefixCtes, ctx.sql);
	return [{ stage: 'select', sql: fullSql, line: startLine0(qe), order: 0 }];
}

function extractSetopClauses(body: SetOpExpr, ctx: Omit<StageCtx, 'orderBy' | 'limit' | 'fullTextStart' | 'fullTextStop'>): DecomposeClause[] {
	const legs = collectLegs(body);
	const combined: DecomposeClause[] = [];
	legs.forEach((leg, i) => {
		const legClauses = buildSelectClauses(leg, {
			...ctx,
			fullTextStart: startOffset(leg),
			fullTextStop: stopOffset(leg),
		});
		for (const c of legClauses) {
			c.union_leg = i + 1;
			c.union_total = legs.length;
		}
		combined.push(...legClauses);
	});
	return combined.map((c, order) => ({ ...c, order }));
}

/**
 * Decompose compiled SQL into debug frames (CTEs + `_main_`) and per-frame stage
 * clauses. Returns the typed contract object; the debug-adapter seam JSON-stringifies
 * it. Never throws — parse/slice failures are reported as { success: false }.
 */
export function decompose(compiledSql: string, dialect: Dialect): DecomposeResult {
	if (!compiledSql) {
		return { success: false, error: 'compiled_sql is required', frames: [], clauses: {}, refs: {} };
	}

	try {
		const { ast, tokens } = parse(compiledSql, dialect);
		const frames: DecomposeFrame[] = [];
		const clauses: Record<string, DecomposeClause[]> = {};
		const refs: Record<string, string[]> = {};

		// CTE frames, in declaration order.
		for (const cte of ast.ctes) {
			const name = cte.name;
			if (!name) continue;
			frames.push({
				name,
				type: 'cte',
				line: startLine0(cte),
				endLine: stopLine0(cte),
			});
			const ctx = { sql: compiledSql, tokens, prefixCtes: precedingCtes(ast.ctes, name) };
			clauses[name] = extractClauses(cte.body.body, ctx, cte.body);
			refs[name] = tableRefs(cte.body.body);
		}

		// _main_ frame — the top-level query. Its span covers the leading WITH, so its
		// SELECT stage runs as-is; its from/where stages get the WITH prefix rebuilt.
		const mainName = '_main_';
		frames.push({
			name: mainName,
			type: 'select',
			line: startLine0(ast.body),
			endLine: newlineCount(compiledSql),
		});
		const mainCtx = { sql: compiledSql, tokens, prefixCtes: precedingCtes(ast.ctes, mainName) };
		clauses[mainName] = extractClauses(ast.body, mainCtx, ast);
		refs[mainName] = tableRefs(ast.body);

		return { success: true, frames, clauses, refs };
	} catch (err) {
		return {
			success: false,
			error: `Decompose error: ${err instanceof Error ? err.message : String(err)}`,
			frames: [],
			clauses: {},
			refs: {},
		};
	}
}

function newlineCount(sql: string): number {
	let n = 0;
	for (let i = 0; i < sql.length; i++) if (sql[i] === '\n') n++;
	return n;
}
