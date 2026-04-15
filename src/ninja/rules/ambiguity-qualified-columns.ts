import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { ColumnRefToken } from '../../services/parse-service';
import type { JinjaToken } from '../../dbt/jinja-tokenizer';

/**
 * Flags column references that lack a table qualifier in multi-source contexts.
 *
 * When a query has multiple table sources (JOINs, subqueries), unqualified
 * column references are ambiguous. This rule checks column_ref tokens
 * that have no `table` qualifier and exist in scopes with 2+ table_refs.
 */
export const qualifiedColumnsRule: TokenRule = {
	id: 'ninja.ambiguity.qualified-columns',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'info',
	description: 'Column references should be qualified with a table name when multiple sources are present.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, jinjaTokens = [] } = ctx;

		// Count only real FROM/JOIN refs — exclude cteDefinition and synthesized tokens
		// so a single-source CTE query is not treated as multi-source.
		const tableRefs = model.tokens.filter(
			t => t.type === 'table_ref' && !t.cteDefinition && !t.synthesized,
		);
		if (tableRefs.length < 2) return [];

		const violations: NinjaViolation[] = [];

		for (const tok of model.tokens) {
			if (tok.type !== 'column_ref') continue;
			const colRef = tok as ColumnRefToken;

			// Skip if already qualified
			if (colRef.table) continue;

			// Skip wildcard columns (*)
			if (colRef.name === '*') continue;

			// Skip column refs that originate inside a Jinja expression (blanker placeholder)
			const colOffset = document.offsetAt(new vscode.Position(colRef.line, colRef.col));
			if (isInsideJinja(colOffset, jinjaTokens)) continue;

			const range = new vscode.Range(colRef.line, colRef.col, colRef.line, colRef.endCol);
			violations.push({
				rule: 'ninja.ambiguity.qualified-columns',
				message: `Column '${colRef.name}' is unqualified — add a table qualifier for clarity.`,
				range,
			});
		}

		return violations;
	},
};

function isInsideJinja(offset: number, tokens: JinjaToken[]): boolean {
	return tokens.some(t => offset >= t.start && offset < t.end);
}
