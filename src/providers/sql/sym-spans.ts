import * as vscode from 'vscode';
import type { Sym } from '../../ftl/sqllens/api';
import type { CteInfo } from '../../services/parse-service';

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
 * The `vscode.Range` for a CTE Sym's own name — declaration (`WITH name AS
 * (body)`) or reference (`FROM name`/`JOIN name AS alias`). Two cases need
 * narrowing down from a wider `span`:
 *   - A DECLARATION's span always covers the whole clause (`CteDef.nameCst`
 *     has the narrow span in the IR; `deriveSymbols` doesn't surface it).
 *   - An ALIASED reference's span extends through the trailing alias
 *     (verified empirically — `FROM orders o` gives the relation Sym a span
 *     covering "orders o", not just "orders"; `Sym.alias` carries the
 *     alias's own sub-span separately, and its presence is what signals
 *     narrowing is needed here).
 * An UNALIASED reference's span is already name-only — narrowing it via
 * `name.length` would be actively wrong for a QUOTED name (`Sym.name` has
 * its delimiters stripped, so its length undershoots the raw token's width,
 * cutting off the closing delimiter); passing it through unchanged is both
 * simpler and correct.
 *
 * A CTE name is always a literal SQL identifier (never a jinja tag, unlike a
 * `ref()`/`source()`-backed table Sym), so it's always the FIRST thing at the
 * span's start in both narrowing cases — derived from the span's start plus
 * the name's length. That arithmetic is exact for an UNQUOTED name; a QUOTED
 * declaration or aliased reference still undershoots the same way an
 * unaliased one would have (delimiter chars `name` doesn't carry) — the same
 * class of gap `nameRangeOf` has for a quoted column alias, tracked on the
 * sqllens-anvil channel, not solved here.
 *
 * A `table`/`subquery`/`lateral` reference Sym is NOT narrowed at all — its
 * `name` may not match its source text width (a `ref()`/`source()` tag
 * renders as a different width than the resolved table name) — those pass
 * through `rangeOfSpan` unchanged; in practice the CTE-only callers of this
 * helper never see one (renaming a `ref()`-backed table goes through the
 * cross-file manifest path, gated well before reaching here).
 */
export function relationNameRangeOf(sym: Sym): vscode.Range {
	if (sym.kind === 'cte' && (sym.modifiers.includes('declaration') || sym.alias !== undefined)) {
		const { line, column } = sym.span;
		return new vscode.Range(line - 1, column, line - 1, column + sym.name.length);
	}
	return rangeOfSpan(sym.span);
}

/**
 * A `cte`-kind Sym's own anchor to its declaration: a declaration Sym's own `span`,
 * or a reference Sym's `.definition` (the span sqllens itself resolved the reference
 * to, via the real scope-tree walk — not a name lookup). `undefined` only for a
 * non-cte Sym or an unresolved reference.
 *
 * This is the SAME kind of structural identity `symbolBindings.sourceOf`/`aliasOf`
 * already use elsewhere in this extension (object identity between Syms) — CTEs are
 * the one case that also needs to bridge to `CteInfo` (this extension's separate,
 * non-Sym CTE extraction), which carries no back-reference to any `Sym`. Position is
 * the shared anchor across that boundary: `extractCtes` anchors `CteInfo.line/col`
 * at the same start token `deriveSymbols` anchors a declaration's `span` (or a
 * reference's `definition`) at.
 *
 * `.name` is NOT a safe substitute here: for a CTE, `Sym.name` is sqllens's
 * `displayName` — the DECLARED spelling, copied from the declaration's own name
 * object onto every Sym for that CTE regardless of how each individual reference was
 * actually typed (`displayName`'s own doc comment: "never use this for comparison;
 * two displayName results being equal proves nothing about identity"). `CteInfo.name`
 * (this extension's `extractCtes`) instead folds through `normName`/`foldIdentifier`
 * for dialect-aware casing (e.g. Snowflake uppercases unquoted identifiers). The two
 * disagree for any CTE name containing a non-lowercase letter — found live while
 * migrating the reference/rename/call-hierarchy cluster off `model.tokens`.
 */
function cteAnchorOf(sym: Sym): SpanLike | undefined {
	if (sym.kind !== 'cte') return undefined;
	return sym.modifiers.includes('declaration') ? sym.span : sym.definition;
}

/** True when a `cte`-kind Sym (declaration or reference) identifies the same CTE as
 *  `cte` — matched by structural anchor (see `cteAnchorOf`), never by name string. */
export function symMatchesCte(sym: Sym, cte: CteInfo): boolean {
	const anchor = cteAnchorOf(sym);
	if (!anchor) return false;
	return anchor.line - 1 === cte.line && anchor.column === (cte.col ?? 0);
}

/** True when two `cte`-kind Syms (declaration and/or reference, any combination)
 *  identify the SAME CTE — matched by structural anchor (see `cteAnchorOf`), never
 *  by `.name`. Every Sym for one CTE happens to carry the same `displayName`-derived
 *  `.name` already (see `cteAnchorOf`'s doc comment on why that's incidental, not a
 *  safe general rule) — this compares anchors directly instead, with no `CteInfo`
 *  needed at all. */
export function symsMatchSameCte(a: Sym, b: Sym): boolean {
	const anchorA = cteAnchorOf(a);
	const anchorB = cteAnchorOf(b);
	if (!anchorA || !anchorB) return false;
	return anchorA.line === anchorB.line && anchorA.column === anchorB.column;
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
