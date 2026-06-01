import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { CteInfo, ColumnRefToken } from '../../services/parse-service';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import type { SqlToken } from '../../ftl/parse-result';

/**
 * Flags columns defined in a CTE that are never referenced downstream.
 *
 * For each CTE, collects its defined columns and checks whether any
 * column_ref token with a matching resolvedTableRef references them.
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
		// Pass 2 AST column numbers are in rendered-space and not remapped —
		// building ranges from them causes negative-character errors.
		if (model.isPass2) return [];

		// Build a map of CTE name (lower) → set of referenced column names (lower)
		const referencedColumns = buildReferencedColumnsMap(model.ctes, model.tokens);

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
 * A column_ref references a CTE when:
 * - Its resolvedTableRef.name matches a CTE name, OR
 * - Its table qualifier matches a CTE name/alias and it falls outside that CTE's body
 */
function buildReferencedColumnsMap(
	ctes: CteInfo[],
	tokens: import('../../services/parse-service').TokenInfo[],
): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();

	// Index CTE names and aliases for lookup
	const cteByName = new Map<string, CteInfo>();
	const cteByAlias = new Map<string, CteInfo>();
	for (const c of ctes) {
		cteByName.set(c.name.toLowerCase(), c);
		if (c.alias) cteByAlias.set(c.alias.toLowerCase(), c);
	}

	for (const tok of tokens) {
		if (tok.type !== 'column_ref') continue;
		const colRef = tok as ColumnRefToken;

		let targetCte: CteInfo | undefined;

		// First: use resolvedTableRef if available
		if (colRef.resolvedTableRef) {
			targetCte = cteByName.get(colRef.resolvedTableRef.name.toLowerCase())
				?? cteByAlias.get(colRef.resolvedTableRef.name.toLowerCase());
		}

		// Fallback: use the table qualifier directly
		if (!targetCte && colRef.table) {
			targetCte = cteByName.get(colRef.table.toLowerCase())
				?? cteByAlias.get(colRef.table.toLowerCase());
		}

		if (!targetCte) continue;

		// Column must be outside the CTE body (downstream reference)
		if (colRef.line >= targetCte.line && colRef.line <= targetCte.endLine) continue;

		const key = targetCte.name.toLowerCase();
		let set = result.get(key);
		if (!set) {
			set = new Set();
			result.set(key, set);
		}
		set.add(colRef.name.toLowerCase());
	}

	return result;
}
