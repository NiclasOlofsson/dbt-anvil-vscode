import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

/**
 * Flags table references in FROM/JOIN that lack an alias.
 *
 * Using table aliases (e.g. `FROM orders o`) makes queries shorter
 * and column qualifications more readable. Only flags tables when
 * there are 2+ table sources (single-table queries don't need aliases).
 */
export const requireTableAliasRule: TokenRule = {
	id: 'ninja.aliasing.require-table-alias',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'info',
	description: 'Table references should have aliases when multiple sources are present.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		if (!model.symbols) return [];

		// A FROM/JOIN source is kind 'table' (base table) or 'cte' (CTE reference),
		// always modifiers:['reference'] — this excludes the CTE's own declaration site.
		const fromRefs = model.symbols.filter(
			s => (s.kind === 'table' || s.kind === 'cte') && s.modifiers.includes('reference'),
		);
		if (fromRefs.length < 2) return [];

		const violations: NinjaViolation[] = [];

		for (const ref of fromRefs) {
			if (model.symbolBindings!.aliasOf.get(ref)) continue;

			const range = new vscode.Range(ref.span.line - 1, ref.span.column, ref.span.endLine - 1, ref.span.endColumn);
			violations.push({
				rule: 'ninja.aliasing.require-table-alias',
				message: `Table '${ref.name}' should have an alias.`,
				range,
			});
		}

		return violations;
	},
};
