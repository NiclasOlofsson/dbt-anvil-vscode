/**
 * Schema-fed `SELECT *` expansion — the sqllens-native analog of the legacy path's
 * `qualify(ast, schema=…, infer_schema=True, qualify_columns=True)` star expansion.
 *
 * sqllens `qualify()` is READ-ONLY: unlike sqlglot it never rewrites the IR to replace
 * `*` with explicit columns. Instead it resolves each scope's output column names
 * (`Qualification.columnsOf`), stars expanded, against a `Schema` catalog. This module
 * turns that into per-star column lists the structural extractors splice into
 * `finalColumns` / `finalSelect.columns` / `CteInfo.columns`, so those fields match
 * the legacy post-qualify shape.
 *
 * Like legacy, expansion is best-effort: a star whose sources' columns are unknown
 * (a bare table with no schema entry, an un-inferable derived relation) is left
 * unexpanded — the extractor keeps its `*` / skip behavior, exactly as sqlglot's
 * `infer_schema` leaves an unresolvable `*` in place. Running qualify with an EMPTY
 * schema still expands stars sourced from CTEs / subqueries whose columns are
 * structurally inferable, which is what the legacy path does unconditionally
 * (`infer_schema=True` + its CTE-schema supplement).
 */
import type { ColumnInfo, FinalSelectColumnInfo } from '../../../services/parse-service';
import type { Projection, Qualification, ResolvedSource, Schema, Scope, ScopeTree } from '../api';
import { qualify } from '../api';
import { asCst, normName } from './spans';

/** One expanded star column: its (raw, un-normalized) output name and the source key it
 *  binds to — the qualifier sqlglot's qualify_columns would prepend (e.g. `joined` for
 *  `joined.customer_name`), used to fill `FinalSelectColumnInfo.table`. */
export interface ExpandedColumn {
	name: string;
	table?: string;
}

export interface StarExpander {
	/**
	 * Expand a star projection within `scope` into its ordered output columns, or
	 * `undefined` when the star cannot be resolved (a source's columns are unknown) —
	 * the caller then leaves the star unexpanded, matching the legacy path.
	 */
	expandStar(scope: Scope, proj: Projection): ExpandedColumn[] | undefined;
}

/**
 * Build a star expander over a parsed scope tree + a `Schema` catalog. Runs sqllens
 * `qualify()` once (read-only — it never mutates the IR) to resolve derived-source
 * columns. Returns `undefined` if qualify throws, so extraction falls back cleanly to
 * unexpanded output (item 3 of the wiring: qualification failures never break parsing).
 * Partial failures need no special handling — an unresolvable source makes a single
 * star return `undefined`, leaving just that star unexpanded.
 */
export function buildStarExpander(scopes: ScopeTree, schema: Schema): StarExpander | undefined {
	let q: Qualification;
	try {
		q = qualify(scopes, schema);
	} catch {
		return undefined;
	}
	return {
		expandStar: (scope, proj) => expandStar(scope, proj, schema, q),
	};
}

/** Databricks/Snowflake identifiers are case-insensitive; strip backticks + lowercase.
 *  Matches sqllens's own `normalizeName` used for scope source keys + modifier matching. */
function normKey(name: string): string {
	const unquoted = name.startsWith('`') && name.endsWith('`') ? name.slice(1, -1) : name;
	return unquoted.toLowerCase();
}

function expandStar(scope: Scope, proj: Projection, schema: Schema, q: Qualification): ExpandedColumn[] | undefined {
	const star = proj.expr.kind === 'star' ? proj.expr : undefined;
	if (!star) return undefined; // not modelled as a star node — nothing to expand
	// A qualified `t.*` expands only the source keyed by `t` (its last part); a bare `*`
	// expands every source in FROM order. Mirrors qualify.ts `expandStar`.
	const want = star.qualifier ? normKey(star.qualifier[star.qualifier.length - 1] ?? '') : undefined;
	const out: ExpandedColumn[] = [];
	let matched = false;
	for (const [key, src] of scope.sources) {
		if (want !== undefined && key !== want) continue;
		// A bare `*` skips a pseudo-column source (CONNECT BY LEVEL) — real pseudo-column
		// semantics; a qualified star can't target it (no alias). Matches qualify.ts.
		if (want === undefined && src.kind === 'lateral' && src.source.pseudo) continue;
		matched = true;
		const cols = sourceColumns(src, schema, q);
		if (cols === undefined) return undefined; // a source's columns are unknown — leave the star
		for (const c of cols) out.push({ name: c, table: key });
	}
	if (want !== undefined && !matched) return undefined; // qualified star naming no visible source
	return applyStarModifiers(out, star);
}

/** The output column names of a source — the schema catalog for a table, the resolved
 *  child names for a CTE / subquery / pipe relation, the AS columns for a lateral view.
 *  `undefined` when unknown (needs a catalog we lack). Mirrors qualify.ts `columnsOfSource`. */
function sourceColumns(src: ResolvedSource, schema: Schema, q: Qualification): string[] | undefined {
	switch (src.kind) {
		case 'table':
			if (src.source.columnAliases) return src.source.columnAliases;
			return schema.columnsFor(src.name)?.map(c => c.name);
		case 'cte':
			return src.ref.def.columnAliases ?? known(q.columnsOf(src.ref.scope));
		case 'subquery':
			return src.source.columnAliases ?? known(q.columnsOf(src.scope));
		case 'lateral':
			return src.source.columns;
		case 'relation':
		case 'graphtable':
			return known(q.columnsOf(src.scope));
		case 'pivot':
			// A reshaped PIVOT/UNPIVOT column set — not expanded structurally (rare; the
			// legacy path's pivot handling is a separate concern). Leave the star as-is.
			return undefined;
		default:
			return undefined;
	}
}

function known(r: string[] | 'unknown'): string[] | undefined {
	return r === 'unknown' ? undefined : r;
}

/** Apply a star's EXCLUDE / ILIKE / RENAME modifiers to an expansion. Mirrors scope.ts
 *  `applyStarModifiers` (REPLACE keeps name + position, so it never changes the set). */
function applyStarModifiers(
	cols: ExpandedColumn[],
	star: { exclude?: string[]; ilike?: string; rename?: { from: string; to: string }[] },
): ExpandedColumn[] {
	let out = cols;
	if (star.exclude) {
		const removed = new Set(star.exclude.map(normKey));
		out = out.filter(c => !removed.has(normKey(c.name)));
	}
	if (star.ilike !== undefined) {
		const rx = likePatternToRegExp(star.ilike);
		out = out.filter(c => rx.test(normKey(c.name)));
	}
	if (star.rename) {
		const renames = new Map(star.rename.map(r => [normKey(r.from), r.to]));
		out = out.map(c => {
			const nn = renames.get(normKey(c.name));
			return nn ? { ...c, name: nn } : c;
		});
	}
	return out;
}

/** SQL LIKE pattern → anchored case-insensitive RegExp (`%` → `.*`, `_` → `.`). Mirrors scope.ts. */
function likePatternToRegExp(pattern: string): RegExp {
	const escaped = pattern
		.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
		.replace(/%/g, '.*')
		.replace(/_/g, '.');
	return new RegExp(`^${escaped}$`, 'i');
}

/**
 * The source anchor for expanded star columns: the star token's line (0-based) and its
 * exclusive END column. Legacy anchors every synthesized column at the `*`'s position
 * (`_annotate_synthesized_columns`), reading sqlglot's `_meta.col` as the chars-consumed
 * END; the per-column `col` is then `endCol - name.length`. `asCst(p.cst).start` is the
 * `*` (bare) / leading `t` (qualified) token — its end is `column + text.length`.
 */
function starAnchor(p: Projection): { line: number; endCol: number } | undefined {
	const t = asCst(p.cst).start;
	return t ? { line: t.line - 1, endCol: t.column + (t.text?.length ?? 1) } : undefined;
}

/** Expanded-star entries as `ColumnInfo[]` (finalColumns / CteInfo.columns). Names are
 *  normalized through `normName` for parity with the legacy lowercase serialization. */
export function expandedColumnInfos(p: Projection, cols: ExpandedColumn[]): ColumnInfo[] {
	const a = starAnchor(p);
	return cols.map(ec => {
		const name = normName(ec.name);
		const info: ColumnInfo = { name, line: a ? a.line : 0 };
		if (a) info.col = a.endCol - name.length;
		return info;
	});
}

/** Expanded-star entries as `FinalSelectColumnInfo[]`. Legacy's post-qualify synthesized
 *  columns are qualified `Column` nodes, so each carries `expression` (the column name)
 *  and `table` (the source qualifier); the span is the star anchor. */
export function expandedFinalSelectColumns(p: Projection, cols: ExpandedColumn[]): FinalSelectColumnInfo[] {
	const a = starAnchor(p);
	return cols.map(ec => {
		const name = normName(ec.name);
		const entry: FinalSelectColumnInfo = {
			name,
			line: a ? a.line : 0,
			col: a ? a.endCol - name.length : 0,
			endLine: a ? a.line : 0,
			endCol: a ? a.endCol : 0,
			expression: name,
		};
		if (ec.table) entry.table = ec.table;
		return entry;
	});
}
