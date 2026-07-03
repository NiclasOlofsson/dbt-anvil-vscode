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
import type { Projection, QueryBody } from '../api';
import { allScopes, asCst, leftSelect, normName, type SqllensParse } from './spans';

/** One output-column entry for a CTE / subquery body projection. */
function projColumnInfo(p: Projection): ColumnInfo | undefined {
	// A CTE's `SELECT *` column is read straight off the projection (no wildcard
	// side-channel): sqllens never destructively expands it, so `isStar` survives.
	const name = p.isStar ? '*' : (p.name === undefined ? undefined : normName(p.name));
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

function columnsOf(body: QueryBody): ColumnInfo[] {
	const sel = leftSelect(body);
	if (!sel) return [];
	const out: ColumnInfo[] = [];
	for (const p of sel.projections) {
		const info = projColumnInfo(p);
		if (info) out.push(info);
	}
	return out;
}

export function extractCtes(parse: SqllensParse): CteInfo[] {
	const result: CteInfo[] = [];
	const seen = new Set<string>();

	for (const scope of allScopes(parse.scopes)) {
		// WITH-clause CTEs declared for this scope.
		for (const [, cteRef] of scope.ctes) {
			const name = normName(cteRef.def.name);
			if (seen.has(name)) continue;
			seen.add(name);

			const c = asCst(cteRef.def.cst);
			const startTok = c.start;
			const stopTok = c.stop;
			const startLine = startTok ? startTok.line - 1 : 0;

			const entry: CteInfo = {
				name,
				line: startLine,
				endLine: stopTok ? stopTok.line - 1 : startLine,
				columns: columnsOf(cteRef.scope.body),
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

			const entry: CteInfo = {
				name: alias,
				line: startLine,
				endLine: aliasTok ? aliasTok.line - 1 : startLine,
				columns: columnsOf(src.scope.body),
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
