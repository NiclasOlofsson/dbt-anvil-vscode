import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { CteInfo, ColumnRefToken } from '../../services/parse-service';

/**
 * Flags columns defined in a CTE that are never referenced downstream.
 *
 * For each CTE, collects its defined columns and checks whether any
 * column_ref token with a matching resolvedTableRef references them.
 * Skips CTEs whose column list contains '*' (SELECT * bodies).
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
		const referencedColumns = buildReferencedColumnsMap(model.ctes, model.tokens);

		const violations: NinjaViolation[] = [];

		for (const cte of model.ctes) {
			// Skip CTEs with wildcard columns — we can't know what's used
			if (cte.columns.some(c => c.name === '*')) continue;
			if (cte.columns.length === 0) continue;

			const refSet = referencedColumns.get(cte.name.toLowerCase());

			for (const col of cte.columns) {
				if (refSet?.has(col.name.toLowerCase())) continue;

				const range = new vscode.Range(col.line, 0, col.line, col.name.length);
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
