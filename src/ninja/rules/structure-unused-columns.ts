import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { CteInfo } from '../../services/parse-service';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import type { SqlToken } from '../../ftl/sql-tokens';
import type { Sym } from '../../ftl/sqllens/api';

/**
 * Flags columns defined in a CTE that are never referenced downstream.
 *
 * For each CTE, collects its defined columns and checks whether any
 * column Sym bound (via `Sym.source`) to that CTE references them.
 *
 * Skips CTEs whose SELECT list contains a wildcard — either bare
 * (`select *`) or qualified (`select cp.*`). The Python `qualify()` pass
 * rewrites `cp.*` into individual Column nodes before the TypeScript
 * extractor sees them, and the synthesised columns end up with broken
 * source positions. Rather than try to recover positions or distinguish
 * synthesised columns post-qualify, the rule probes the raw token
 * stream for wildcard markers in each CTE's select list. This keeps
 * `cte.columns` intact (lineage / completion / hover still see the full
 * column set) while suppressing the per-column false positives.
 */
export const unusedColumnsRule: TokenRule = {
	id: 'ninja.structure.unused-columns',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'info',
	description: 'Column defined in a CTE is never referenced downstream.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		if (model.ctes.length === 0) return [];

		// Build a map of CTE name (lower) → set of referenced column names (lower)
		const referencedColumns = buildReferencedColumnsMap(model.ctes, model.symbols ?? []);

		const sqlTokens = sqlOnly(model.ninjaSqlTokens);

		const violations: NinjaViolation[] = [];

		for (const cte of model.ctes) {
			// Skip CTEs whose AST-derived column list still includes a literal
			// '*' (bare `SELECT *` path, where the TS extractor short-circuited
			// before qualify expanded it).
			if (cte.columns.some(c => c.name === '*')) continue;
			// Skip CTEs whose token stream shows any wildcard in their own
			// SELECT list. Catches `cp.*` and other qualified wildcards that
			// qualify() expands silently.
			if (cteHasWildcardSelect(cte, sqlTokens)) continue;
			if (cte.columns.length === 0) continue;

			const refSet = referencedColumns.get(cte.name.toLowerCase());

			for (const col of cte.columns) {
				if (refSet?.has(col.name.toLowerCase())) continue;

				const startCol = Math.max(0, col.col ?? 0);
				const range = new vscode.Range(col.line, startCol, col.line, startCol + col.name.length);
				violations.push({
					rule: 'ninja.structure.unused-columns',
					message: `Column '${col.name}' in CTE '${cte.name}' is never referenced downstream.`,
					range,
				});
			}
		}

		return violations;
	},
};

/**
 * True when the CTE's own SELECT list contains a wildcard `*`. We look
 * at tokens in the CTE's line range, track paren depth from the start
 * (so the CTE's own body is depth 1 — any STAR at depth >= 2 belongs to
 * a subquery or function call, not this CTE's SELECT list), and require
 * the STAR to be preceded by SELECT / COMMA / DOT / DISTINCT so we
 * don't false-trigger on multiplication (`a * b`, prev = VAR) or
 * `COUNT(*)` (prev = L_PAREN).
 */
function cteHasWildcardSelect(cte: CteInfo, sqlTokens: SqlToken[]): boolean {
	const WILDCARD_PREV = new Set(['SELECT', 'COMMA', 'DOT', 'DISTINCT']);
	let depth = 0;
	let prevType: string | undefined;
	for (const tok of sqlTokens) {
		if (tok.line < cte.line) continue;
		if (tok.line > cte.endLine) break;
		const type = tok.type.toUpperCase();
		if (type === 'L_PAREN') { depth++; prevType = type; continue; }
		if (type === 'R_PAREN') { depth = Math.max(0, depth - 1); prevType = type; continue; }
		if (type === 'STAR' && depth === 1 && prevType && WILDCARD_PREV.has(prevType)) {
			return true;
		}
		prevType = type;
	}
	return false;
}

/**
 * Build a map: CTE name (lowercase) → Set of column names (lowercase) referenced on it.
 *
 * A column Sym references a CTE when its bound source (`Sym.source`) resolves to a
 * `kind: 'cte'` relation Sym matching a known CTE, and the reference falls outside
 * that CTE's own body (a genuine downstream use, not a self-reference). sqllens's
 * real column resolution (`deriveSymbols`) resolves both qualified and bare columns
 * uniformly, so there is no separate qualifier-string fallback tier here — a column
 * with no resolvable source (`.source` absent) simply doesn't count as a reference.
 */
function buildReferencedColumnsMap(
	ctes: CteInfo[],
	symbols: Sym[],
): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();

	// Index CTE names for lookup
	const cteByName = new Map<string, CteInfo>();
	for (const c of ctes) cteByName.set(c.name.toLowerCase(), c);

	for (const colSym of symbols) {
		if (colSym.kind !== 'column' || !colSym.modifiers.includes('reference')) continue;

		const source = colSym.source;
		if (!source || source.kind !== 'cte') continue;

		const targetCte = cteByName.get(source.name.toLowerCase());
		if (!targetCte) continue;

		// Column must be outside the CTE body (downstream reference)
		const line = colSym.span.line - 1;
		if (line >= targetCte.line && line <= targetCte.endLine) continue;

		const key = targetCte.name.toLowerCase();
		let set = result.get(key);
		if (!set) {
			set = new Set();
			result.set(key, set);
		}
		set.add(colSym.name.split('.').pop()!.toLowerCase());
	}

	return result;
}
