/**
 * Schema-fed `SELECT *` expansion — turns sqllens's own `Qualification.expandStarOf`
 * into the per-star column lists the structural extractors splice into `finalColumns`
 * / `finalSelect.columns` / `CteInfo.columns`.
 *
 * sqllens `qualify()` is READ-ONLY: it never rewrites the IR to replace `*` with
 * explicit columns. `expandStarOf` resolves a star projection's output columns (star
 * modifiers — EXCLUDE/ILIKE/RENAME — already applied) against a `Schema` catalog,
 * dialect-aware fold matching included. Expansion is best-effort: a star whose
 * sources' columns are unknown (a bare table with no schema entry, an un-inferable
 * derived relation) is left unexpanded — the extractor keeps its `*` / skip behavior.
 * Running qualify with an EMPTY schema still expands stars sourced from CTEs /
 * subqueries whose columns are structurally inferable.
 */
import type { ColumnInfo, FinalSelectColumnInfo } from '../../../services/parse-service';
import type { Dialect, Projection, Qualification, SchemaProvider, Scope, ScopeTree } from '../api';
import { qualify } from '../api';
import { asCst, normName } from './spans';

/** One expanded star column: its (raw, un-normalized) output name and the source key it
 *  binds to (the same fold-normalized key `scope.sources` is keyed by) — used to fill
 *  `FinalSelectColumnInfo.table` and to look the source back up via `scope.sources.get`. */
export interface ExpandedColumn {
	name: string;
	table?: string;
}

export interface StarExpander {
	/**
	 * Expand a star projection within `scope` into its ordered output columns, or
	 * `undefined` when the star cannot be resolved (a source's columns are unknown) —
	 * the caller then leaves the star unexpanded.
	 */
	expandStar(scope: Scope, proj: Projection): ExpandedColumn[] | undefined;
}

/**
 * Build a star expander over a parsed scope tree + a `Schema` catalog. Runs sqllens
 * `qualify()` once (read-only — it never mutates the IR) to resolve derived-source
 * columns; pass `prebuilt` to reuse a Qualification the caller already ran over the
 * same tree + schema instead. Returns `undefined` if qualify throws, so extraction
 * falls back cleanly to unexpanded output. Partial failures need no special handling —
 * an unresolvable source makes a single star return `undefined`, leaving just that
 * star unexpanded.
 */
export function buildStarExpander(scopes: ScopeTree, schema: SchemaProvider, prebuilt?: Qualification): StarExpander | undefined {
	let q: Qualification;
	if (prebuilt) {
		q = prebuilt;
	} else {
		try {
			q = qualify(scopes, schema);
		} catch {
			return undefined;
		}
	}
	return {
		expandStar: (scope, proj) => q.expandStarOf(scope, proj)?.map(p => ({ name: p.name, table: p.sourceKey })),
	};
}

/**
 * The anchor span for expanded star columns: the `*` CHARACTER itself,
 * `[starCol, starEnd)` — the anchoring decision: a highlight over a column that
 * exists only by expansion must cover the star, never a position synthesized
 * from it (legacy's `endCol - name.length` invented starts inside preceding
 * text). The `*` is the star node's stop token for a qualified `t.*` and its
 * start token for a bare `*` (with or without EXCEPT/EXCLUDE modifiers); a
 * modified qualified star (`t.* except (…)`) has the `*` mid-node, so the whole
 * node span anchors — wider, but it still covers the star.
 */
function starAnchor(p: Projection): { line: number; col: number; endLine: number; endCol: number } | undefined {
	const n = asCst(p.expr.cst);
	const start = n.start;
	if (!start) return undefined;
	const stop = n.stop;
	const starTok = stop?.text === '*' ? stop : start.text === '*' ? start : undefined;
	if (starTok) {
		return { line: starTok.line - 1, col: starTok.column, endLine: starTok.line - 1, endCol: starTok.column + 1 };
	}
	const end = stop ?? start;
	return { line: start.line - 1, col: start.column, endLine: end.line - 1, endCol: end.column + (end.text?.length ?? 1) };
}

/** Expanded-star entries as `ColumnInfo[]` (finalColumns / CteInfo.columns). Names are
 *  normalized through `normName` for parity with the legacy lowercase serialization. */
export function expandedColumnInfos(p: Projection, cols: ExpandedColumn[], dialect: Dialect): ColumnInfo[] {
	const a = starAnchor(p);
	return cols.map(ec => {
		const name = normName(ec.name, dialect);
		const info: ColumnInfo = { name, line: a ? a.line : 0 };
		if (a) info.col = a.col;
		return info;
	});
}

/** Expanded-star entries as `FinalSelectColumnInfo[]`. Legacy's post-qualify synthesized
 *  columns are qualified `Column` nodes, so each carries `expression` (the column name)
 *  and `table` (the source qualifier); the span is the star anchor. */
export function expandedFinalSelectColumns(p: Projection, cols: ExpandedColumn[], dialect: Dialect): FinalSelectColumnInfo[] {
	const a = starAnchor(p);
	return cols.map(ec => {
		const name = normName(ec.name, dialect);
		const entry: FinalSelectColumnInfo = {
			name,
			line: a ? a.line : 0,
			col: a ? a.col : 0,
			endLine: a ? a.endLine : 0,
			endCol: a ? a.endCol : 0,
			expression: name,
		};
		if (ec.table) entry.table = ec.table;
		return entry;
	});
}
