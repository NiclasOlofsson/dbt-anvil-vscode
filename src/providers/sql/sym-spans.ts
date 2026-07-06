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
 * (`o.order_id`) or bare (`order_id`).
 *
 * A DECLARATION Sym (`AS alias` in a SELECT list) never carries `partSpans` —
 * sqllens's `deriveSymbols` builds it from the whole `Projection`, whose own
 * `span` covers the entire `expr AS alias` clause, not just the alias
 * identifier (the IR's `Projection.aliasCst` has the narrow span, but
 * `deriveSymbols` doesn't surface it on the `Sym`). Since `AS alias` is always
 * the last thing in a projection, the alias's own range is derived from the
 * span's end plus the (already quote-normalized) name's length — exact for an
 * unquoted alias; a quoted alias's source width includes delimiter chars
 * `name` doesn't, the same class of gap already tracked for other quoted
 * identifiers pending sqllens's delimiter-contract work. Filed on the
 * sqllens-anvil channel for a proper `aliasCst`-based fix upstream.
 */
export function nameRangeOf(sym: Sym): vscode.Range {
	if (sym.partSpans?.length) {
		return rangeOfSpan(sym.partSpans[sym.partSpans.length - 1]);
	}
	if (sym.kind === 'column' && sym.modifiers.includes('declaration')) {
		const { endLine, endColumn } = sym.span;
		return new vscode.Range(endLine - 1, endColumn - sym.name.length, endLine - 1, endColumn);
	}
	return rangeOfSpan(sym.span);
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
 * The `vscode.Range` for a relation Sym's own name. A CTE DECLARATION
 * (`WITH name AS (body)`) is the one relation-kind Sym that can carry
 * `modifiers: ['declaration']`, and like a column declaration its own `span`
 * covers the whole clause, not just the name (`CteDef.nameCst` has the narrow
 * span in the IR; `deriveSymbols` doesn't surface it). Unlike a column alias,
 * the CTE name comes FIRST in the clause, so its own range is derived from
 * the span's start plus the name's length. Every other relation Sym (a plain
 * reference, or a subquery/lateral/table, none of which get a declaration
 * form) already has a name-only span and passes through `rangeOfSpan`
 * unchanged.
 */
export function relationNameRangeOf(sym: Sym): vscode.Range {
	if (sym.kind === 'cte' && sym.modifiers.includes('declaration')) {
		const { line, column } = sym.span;
		return new vscode.Range(line - 1, column, line - 1, column + sym.name.length);
	}
	return rangeOfSpan(sym.span);
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
