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
import type { Projection } from '../api';
import { asCst, leftSelect, type SqllensParse } from './spans';

/**
 * The output name of a projection, or `undefined` to skip it. A bare `*` (no
 * qualifier) is skipped (it names nothing concrete without a schema); a qualified
 * `t.*` surfaces as `'*'`. Mirrors the legacy final-select naming.
 */
function projName(p: Projection): string | undefined {
	if (p.isStar) {
		const star = p.expr.kind === 'star' ? p.expr : undefined;
		return star && star.qualifier ? '*' : undefined;
	}
	return p.name;
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
	const start = c.start;
	const stop = c.stop ?? c.start;

	const entry: FinalSelectColumnInfo = {
		name,
		line: start ? start.line - 1 : 0,
		col: start ? start.column : 0,
		endLine: stop ? stop.line - 1 : 0,
		endCol: stop ? stop.column + (stop.text?.length ?? 0) : 0,
	};

	const expr = p.expr;
	if (expr.kind === 'column') {
		entry.expression = expr.parts[expr.parts.length - 1];
		if (expr.parts.length >= 2) entry.table = expr.parts[expr.parts.length - 2];
	} else if (expr.kind !== 'star') {
		// A function / case / cast / arithmetic / literal — the candidate for the
		// `aliasing.expression-no-alias` rule.
		entry.isComplexExpression = true;
	}

	// TODO(sqllens-aliascst): cst.stop is the alias token when explicitly aliased.
	if (isExplicitAlias(p) && stop) {
		entry.aliasLine = stop.line - 1;
		entry.aliasCol = stop.column;
		entry.aliasEndCol = stop.column + (stop.text?.length ?? name.length);
	}

	return entry;
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
