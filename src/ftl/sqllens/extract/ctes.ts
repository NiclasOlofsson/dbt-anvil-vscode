/**
 * CTE + subquery structural extraction from the sqllens scope tree.
 *
 * Produces `CteInfo[]` — one entry per WITH-clause CTE (walking `scope.ctes`
 * across every scope, so CTEs nested inside subqueries are covered) plus one per
 * aliased FROM subquery (`scope.sources` of kind `subquery`). Positions come
 * straight off the IR nodes' CST spans: the CTE name token is `CteDef.cst.start`
 * and the closing paren is `CteDef.cst.stop` (no byte-scan for the matching paren
 * as the sqlglot path needed). See EXTRACTOR-MAP §1.
 */
import type { ColumnInfo, CteInfo } from '../../../services/parse-service';
import type { Dialect, Projection, Scope } from '../api';
import { allScopes, asCst, leftSelect, leftSelectScope, normName, quotedRaw, type SqllensParse } from './spans';
import { expandedColumnInfos, type StarExpander } from './star-expand';

/** One output-column entry for a CTE / subquery body projection. */
function projColumnInfo(p: Projection, dialect: Dialect): ColumnInfo | undefined {
	// A CTE's `SELECT *` column is read straight off the projection (no wildcard
	// side-channel): sqllens never destructively expands it, so `isStar` survives.
	const name = p.isStar ? '*' : (p.name === undefined ? undefined : normName(quotedRaw(p.name, asCst(p.cst).stop?.text ?? undefined), dialect));
	if (name === undefined) return undefined;

	const c = asCst(p.cst);
	// Aliased/computed projections end on the output-name token (cst.stop is the
	// alias when written `expr AS name`); a bare column ends on the column itself.
	// A star's position is its leading token (`*` or the `t` of `t.*`).
	const t = p.isStar ? c.start : (c.stop ?? c.start);
	const info: ColumnInfo = { name, line: 0 };
	if (t) {
		info.line = t.line - 1;
		info.col = t.column;
	}
	return info;
}

/**
 * Output columns of a CTE / subquery body, stars expanded when a schema-fed expander
 * resolves them. The `isCte` flag reproduces the legacy asymmetry: a WITH-clause CTE
 * whose body is a single BARE `SELECT *` keeps its `*` entry (legacy's `wildcardCtes`
 * side-channel restores the wildcard rather than expanding it), whereas every other
 * star — a qualified `t.*`, a mixed `*, extra`, a set-op branch, and any FROM subquery
 * — is expanded, matching legacy's post-qualify extraction.
 */
function columnsOf(scope: Scope, expander: StarExpander | undefined, isCte: boolean, dialect: Dialect): ColumnInfo[] {
	const sel = leftSelect(scope.body);
	if (!sel) return [];
	const selScope = leftSelectScope(scope);

	const soleBareStar =
		isCte &&
		scope.body.kind === 'select' &&
		sel.projections.length === 1 &&
		sel.projections[0].isStar &&
		!(sel.projections[0].expr.kind === 'star' && sel.projections[0].expr.qualifier);

	const out: ColumnInfo[] = [];
	for (const p of sel.projections) {
		if (p.isStar && expander && !soleBareStar) {
			const cols = expander.expandStar(selScope, p);
			if (cols) {
				out.push(...expandedColumnInfos(p, cols, dialect));
				continue;
			}
		}
		const info = projColumnInfo(p, dialect);
		if (info) out.push(info);
	}
	return out;
}

export function extractCtes(parse: SqllensParse, expander?: StarExpander): CteInfo[] {
	const result: CteInfo[] = [];
	const seen = new Set<string>();

	for (const scope of allScopes(parse.scopes)) {
		// WITH-clause CTEs declared for this scope.
		for (const [, cteRef] of scope.ctes) {
			const c = asCst(cteRef.def.cst);
			const name = normName(quotedRaw(cteRef.def.name, c.start?.text ?? undefined), parse.dialect);
			if (seen.has(name)) continue;
			seen.add(name);

			const startTok = c.start;
			const stopTok = c.stop;
			const startLine = startTok ? startTok.line - 1 : 0;

			const entry: CteInfo = {
				name,
				line: startLine,
				endLine: stopTok ? stopTok.line - 1 : startLine,
				columns: columnsOf(cteRef.scope, expander, true, parse.dialect),
			};
			if (startTok) entry.col = startTok.column;
			if (stopTok) entry.endCol = stopTok.column + (stopTok.text?.length ?? 1);
			result.push(entry);
		}

		// Aliased FROM subqueries — a derived table `(SELECT …) AS x`.
		for (const src of scope.sources.values()) {
			if (src.kind !== 'subquery') continue;
			const alias = src.source.alias;
			if (!alias) continue;

			const bodyC = asCst(src.source.cst);
			const aliasC = src.source.aliasCst ? asCst(src.source.aliasCst) : undefined;
			const startLine = bodyC.start ? bodyC.start.line - 1 : 0;
			const aliasTok = aliasC?.start;

			// Anchor the WHOLE entry at the alias name (legacy convention): a
			// `(SELECT …) AS x` derived table is navigated by `x`, and mixing the
			// body's start line with the alias's column yields a (line, col) pair
			// that describes no real text (col can land past the body line's end).
			const entry: CteInfo = {
				name: alias,
				line: aliasTok ? aliasTok.line - 1 : startLine,
				endLine: aliasTok ? aliasTok.line - 1 : startLine,
				columns: columnsOf(src.scope, expander, false, parse.dialect),
				isSubquery: true,
			};
			if (aliasTok) {
				entry.col = aliasTok.column;
				entry.endCol = aliasTok.column + alias.length;
			}
			result.push(entry);
		}
	}

	return result;
}
