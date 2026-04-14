import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { TableRefToken } from '../../services/parse-service';

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

		const tableRefs = model.tokens.filter(t => t.type === 'table_ref') as TableRefToken[];
		if (tableRefs.length < 2) return [];

		const violations: NinjaViolation[] = [];

		for (const ref of tableRefs) {
			if (ref.alias) continue;

			const range = new vscode.Range(ref.line, ref.col, ref.line, ref.endCol);
			violations.push({
				rule: 'ninja.aliasing.require-table-alias',
				message: `Table '${ref.name}' should have an alias.`,
				range,
			});
		}

		return violations;
	},
};
