import * as vscode from 'vscode';
import type { Sym } from '../../ftl/sqllens/api';

/** A sqllens `Span` (1-based line, 0-based column, end-exclusive) — narrowed to the
 *  fields these helpers read, so callers can pass `Sym['span']` or `Sym['definition']`. */
export interface SpanLike {
	line: number;
	column: number;
	endLine: number;
	endColumn: number;
}

/** Convert a sqllens span to a `vscode.Range` (0-based line, matching every other
 *  position in the extension). */
export function rangeOfSpan(span: SpanLike): vscode.Range {
	return new vscode.Range(span.line - 1, span.column, span.endLine - 1, span.endColumn);
}

/**
 * The `vscode.Range` for a column Sym's NAME part (the last dotted part) — matches
 * what the retired TokenInfo bridge's `ColumnRefToken.line/col/endCol` always
 * anchored at, regardless of whether the reference was written qualified
 * (`o.order_id`) or bare (`order_id`). Falls back to the symbol's own span when
 * `partSpans` is absent (a synthesized part, or a declaration site).
 */
export function nameRangeOf(sym: Sym): vscode.Range {
	const span = sym.partSpans?.length ? sym.partSpans[sym.partSpans.length - 1] : sym.span;
	return rangeOfSpan(span);
}

/**
 * The `vscode.Range` for a column Sym's QUALIFIER part (the part directly before
 * the name) — matches the retired bridge's `ColumnRefToken.tableLine/tableCol/
 * tableEndCol`. `undefined` for an unqualified (single-part) reference or when
 * `partSpans` is absent.
 */
export function qualifierRangeOf(sym: Sym): vscode.Range | undefined {
	if (!sym.partSpans || sym.partSpans.length < 2) return undefined;
	return rangeOfSpan(sym.partSpans[sym.partSpans.length - 2]);
}

/** True for the `Sym` kinds `relationSymbol` (sqllens's symbol emitter) produces for a
 *  FROM/JOIN source or CTE reference — every kind that can carry an alias. */
export function isRelationSym(sym: Sym): sym is Sym & { kind: 'table' | 'cte' | 'subquery' | 'lateral' } {
	return sym.kind === 'table' || sym.kind === 'cte' || sym.kind === 'subquery' || sym.kind === 'lateral';
}

/**
 * "line:column" position keys for every column and relation Sym's own name —
 * matches exactly what the retired TokenInfo bridge's `tokens` array (column_ref
 * / table_ref / column_def) contributed. Used by the free-text capitalisation
 * rules (cap-functions.ts, cap-types.ts) to avoid recasing a column, table, or
 * CTE that happens to share text with a SQL function or type keyword (e.g. a
 * column literally named `date` or `sum`).
 */
export function identifierPositionKeys(symbols: readonly Sym[]): Set<string> {
	const keys = new Set<string>();
	for (const s of symbols) {
		if (s.kind === 'column') {
			const r = nameRangeOf(s);
			keys.add(`${r.start.line}:${r.start.character}`);
		} else if (isRelationSym(s)) {
			keys.add(`${s.span.line - 1}:${s.span.column}`);
		}
	}
	return keys;
}
