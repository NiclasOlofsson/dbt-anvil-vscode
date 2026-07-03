/**
 * Final SELECT extraction — `finalColumns` (names + positions) and the richer
 * `finalSelect` (per-column expr/alias spans) for the query's output.
 *
 * The root output select is the leftmost `SelectExpr` (unwrapping a top-level set
 * operation). Positions come off projection CST spans directly — no descendant
 * bounding-box scan, no backward SELECT-keyword search (`SelectExpr.cst.start` is
 * the SELECT keyword). See EXTRACTOR-MAP §3.
 */
import type {
	ColumnInfo,
	FinalSelectColumnInfo,
	FinalSelectInfo,
} from '../../../services/parse-service';
import type { Expr, Projection } from '../api';
import { asCst, leftSelect, normName, type AntlrToken, type CstNode, type SqllensParse } from './spans';

/**
 * The output name of a projection, or `undefined` to skip it. A bare `*` (no
 * qualifier) is skipped (it names nothing concrete without a schema); a qualified
 * `t.*` surfaces as `'*'`. Mirrors the legacy final-select naming, with the
 * identifier NAME normalized (unquoted → lowercase) as the sqlglot path does.
 */
function projName(p: Projection): string | undefined {
	if (p.isStar) {
		const star = p.expr.kind === 'star' ? p.expr : undefined;
		return star && star.qualifier ? '*' : undefined;
	}
	return p.name === undefined ? undefined : normName(p.name);
}

/**
 * Collect the CST spans of every column reference reachable inside an expression
 * — the sqlglot `Identifier` set the legacy `expressionBounds` scans to anchor a
 * projection's span. Function names, literals, `*`, CAST type names, and operators
 * are NOT identifiers, so only `column` nodes contribute (recursed through the
 * modelled compound forms). Window PARTITION/ORDER BY columns count too.
 */
function collectColumnCsts(expr: Expr, out: CstNode[]): void {
	switch (expr.kind) {
		case 'column':
			out.push(asCst(expr.cst));
			break;
		case 'function':
			for (const a of expr.args) collectColumnCsts(a, out);
			if (expr.window) {
				for (const e of expr.window.partitionBy) collectColumnCsts(e, out);
				for (const e of expr.window.orderBy) collectColumnCsts(e, out);
			}
			break;
		case 'binary':
			collectColumnCsts(expr.left, out);
			collectColumnCsts(expr.right, out);
			break;
		case 'unary':
			collectColumnCsts(expr.operand, out);
			break;
		case 'case':
			for (const w of expr.whens) {
				collectColumnCsts(w.when, out);
				collectColumnCsts(w.then, out);
			}
			if (expr.elseExpr) collectColumnCsts(expr.elseExpr, out);
			break;
		case 'cast':
			collectColumnCsts(expr.expr, out);
			break;
		case 'predicate':
			collectColumnCsts(expr.operand, out);
			for (const a of expr.args) collectColumnCsts(a, out);
			break;
		case 'subscript':
			collectColumnCsts(expr.base, out);
			collectColumnCsts(expr.index, out);
			break;
		case 'lambda':
			collectColumnCsts(expr.body, out);
			break;
		case 'with':
			for (const b of expr.bindings) collectColumnCsts(b.value, out);
			collectColumnCsts(expr.result, out);
			break;
		// literal / star / subquery / exists / other: no bounding identifiers.
	}
}

/** True when the projection declares an explicit alias (its name doesn't echo a bare column). */
function isExplicitAlias(p: Projection): boolean {
	if (p.isStar || p.name === undefined) return false;
	const last = p.expr.kind === 'column' ? p.expr.parts[p.expr.parts.length - 1] : undefined;
	return !(last !== undefined && last.toLowerCase() === p.name.toLowerCase());
}

export function extractFinalColumns(parse: SqllensParse): ColumnInfo[] {
	const sel = leftSelect(parse.ast.body);
	if (!sel) return [];

	const out: ColumnInfo[] = [];
	for (const p of sel.projections) {
		const name = projName(p);
		if (name === undefined) continue;
		const c = asCst(p.cst);
		const t = p.isStar ? c.start : (c.stop ?? c.start);
		const entry: ColumnInfo = { name, line: t ? t.line - 1 : 0 };
		if (t) entry.col = t.column;
		out.push(entry);
	}
	return out;
}

function finalSelectColumn(p: Projection): FinalSelectColumnInfo | undefined {
	const name = projName(p);
	if (name === undefined) return undefined;

	const c = asCst(p.cst);
	const explicitAlias = isExplicitAlias(p);
	// The alias token is the projection's last token when written `expr AS name`.
	const aliasTok = explicitAlias ? (c.stop ?? undefined) : undefined;

	const entry: FinalSelectColumnInfo = { name, line: 0, col: 0, endLine: 0, endCol: 0 };

	if (p.isStar) {
		// A qualified `t.*` — anchor on the projection span directly (star expansion
		// is out of the structural-parity scope; `*` names no concrete identifier).
		const start = c.start;
		const stop = c.stop ?? c.start;
		entry.line = start ? start.line - 1 : 0;
		entry.col = start ? start.column : 0;
		entry.endLine = stop ? stop.line - 1 : 0;
		entry.endCol = stop ? stop.column + (stop.text?.length ?? 0) : 0;
	} else {
		// Anchor the span on the projection's IDENTIFIER bounds, replicating the
		// legacy `expressionBounds`: min start / max end over every column-ref token
		// plus the alias token (`sum(x) AS y` anchors at `x`, not the `sum` keyword;
		// `count(*) AS c` and `1 + 2 AS lit`, with no column identifiers, anchor at
		// the alias). No bounds (e.g. bare `count(*)`) → 0/0/0/0, as legacy leaves it.
		const csts: CstNode[] = [];
		collectColumnCsts(p.expr, csts);
		const bounds = identifierBounds(csts, aliasTok);
		if (bounds) {
			entry.line = bounds.startLine;
			entry.col = bounds.startCol;
			entry.endLine = bounds.endLine;
			entry.endCol = bounds.endCol;
		}
	}

	const expr = p.expr;
	if (expr.kind === 'column') {
		entry.expression = normName(expr.parts[expr.parts.length - 1]);
		if (expr.parts.length >= 2) entry.table = normName(expr.parts[expr.parts.length - 2]);
	} else if (expr.kind !== 'star') {
		// A function / case / cast / arithmetic / literal — the candidate for the
		// `aliasing.expression-no-alias` rule.
		entry.isComplexExpression = true;
	}

	if (aliasTok) {
		entry.aliasLine = aliasTok.line - 1;
		entry.aliasCol = aliasTok.column;
		entry.aliasEndCol = aliasTok.column + (aliasTok.text?.length ?? name.length);
	}

	return entry;
}

/**
 * Min start / max end (0-based; endCol exclusive) over a set of column-ref CST
 * spans plus an optional alias token — the projection's identifier bounding box.
 * `undefined` when there are no identifiers at all (a pure literal / `count(*)`).
 */
function identifierBounds(
	csts: CstNode[],
	aliasTok: AntlrToken | undefined,
): { startLine: number; startCol: number; endLine: number; endCol: number } | undefined {
	let sL = Infinity, sC = Infinity, eL = -Infinity, eC = -Infinity;
	const addStart = (t: AntlrToken | null): void => {
		if (!t) return;
		const l = t.line - 1;
		if (l < sL || (l === sL && t.column < sC)) { sL = l; sC = t.column; }
	};
	const addEnd = (t: AntlrToken | null): void => {
		if (!t) return;
		const l = t.line - 1, ec = t.column + (t.text?.length ?? 0);
		if (l > eL || (l === eL && ec > eC)) { eL = l; eC = ec; }
	};
	for (const cc of csts) { addStart(cc.start); addEnd(cc.stop); }
	if (aliasTok) { addStart(aliasTok); addEnd(aliasTok); }
	if (sL === Infinity) return undefined;
	return { startLine: sL, startCol: sC, endLine: eL, endCol: eC };
}

export function extractFinalSelect(parse: SqllensParse): FinalSelectInfo | undefined {
	const sel = leftSelect(parse.ast.body);
	if (!sel) return undefined;

	const selStart = asCst(sel.cst).start;
	const selLine = selStart ? selStart.line - 1 : 0;
	const selCol = selStart ? selStart.column : 0;

	const columns: FinalSelectColumnInfo[] = [];
	for (const p of sel.projections) {
		const col = finalSelectColumn(p);
		if (col) columns.push(col);
	}

	let endLine = selLine;
	let endCol = selCol;
	for (const c of columns) {
		if (c.endLine > endLine || (c.endLine === endLine && c.endCol > endCol)) {
			endLine = c.endLine;
			endCol = c.endCol;
		}
	}

	return { line: selLine, col: selCol, endLine, endCol, columns };
}
