import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { JinjaToken } from '../../ftl/sqllens/extract/coarse-jinja';

/**
 * Flags column references that lack a table qualifier in multi-source contexts.
 *
 * When a query has multiple table sources (JOINs, subqueries), unqualified
 * column references are ambiguous. This rule checks column symbols that
 * carry no dotted qualifier and exist in scopes with 2+ table/CTE sources.
 */
export const qualifiedColumnsRule: TokenRule = {
	id: 'ninja.ambiguity.qualified-columns',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'info',
	description: 'Column references should be qualified with a table name when multiple sources are present.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, jinjaTokens = [] } = ctx;

		// A FROM/JOIN source is kind 'table' (base table) or 'cte' (CTE reference),
		// always modifiers:['reference'] — this excludes the CTE's own declaration site,
		// so a single-source CTE query is not treated as multi-source.
		const tableRefs = (model.symbols ?? []).filter(
			s => (s.kind === 'table' || s.kind === 'cte') && s.modifiers.includes('reference'),
		);
		if (tableRefs.length < 2) return [];

		const violations: NinjaViolation[] = [];

		for (const sym of model.symbols ?? []) {
			if (sym.kind !== 'column' || !sym.modifiers.includes('reference')) continue;

			// Skip wildcard columns (*)
			if (sym.modifiers.includes('star')) continue;

			const line = sym.span.line - 1;
			if (line < 0 || line >= document.lineCount) continue;

			// Skip if already qualified — a dot in sym.name means the user wrote a qualifier.
			if (sym.name.includes('.')) continue;

			// Skip column refs that originate inside a Jinja expression (blanker placeholder)
			const colOffset = document.offsetAt(new vscode.Position(line, sym.span.column));
			if (isInsideJinja(colOffset, jinjaTokens)) continue;

			const range = new vscode.Range(sym.span.line - 1, sym.span.column, sym.span.endLine - 1, sym.span.endColumn);
			violations.push({
				rule: 'ninja.ambiguity.qualified-columns',
				message: `Column '${sym.name}' is unqualified — add a table qualifier for clarity.`,
				range,
			});
		}

		return violations;
	},
};

function isInsideJinja(offset: number, tokens: JinjaToken[]): boolean {
	return tokens.some(t => offset >= t.start && offset < t.end);
}
