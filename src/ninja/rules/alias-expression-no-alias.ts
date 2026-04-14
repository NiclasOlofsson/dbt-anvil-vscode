import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const expressionNoAliasRule: TokenRule = {
	id: 'ninja.aliasing.expression-no-alias',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'warning',
	description: 'Expressions in the final SELECT should have an explicit alias.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		if (!model.finalSelect) return [];

		const violations: NinjaViolation[] = [];

		for (const col of model.finalSelect.columns) {
			if (!col.expression) continue;
			if (col.aliasLine !== undefined) continue;

			violations.push({
				rule: 'ninja.aliasing.expression-no-alias',
				message: `Expression column '${col.expression}' should have an explicit alias.`,
				range: new vscode.Range(col.line, col.col, col.endLine, col.endCol),
			});
		}

		return violations;
	},
};
