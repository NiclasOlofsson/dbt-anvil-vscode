import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const uniqueTableRule: TokenRule = {
	id: 'ninja.aliasing.unique-table',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'warning',
	description: 'Table aliases must be unique within a query.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		const seen = new Map<string, { line: number; col: number }>();

		for (const tok of model.tokens) {
			if (tok.type !== 'table_ref') continue;
			const label = tok.alias ?? tok.name;
			const key = label.toLowerCase();
			const line = tok.aliasLine ?? tok.line;
			const col = tok.aliasCol ?? tok.col;
			const endCol = tok.aliasEndCol ?? tok.endCol;

			const prev = seen.get(key);
			if (prev) {
				violations.push({
					rule: 'ninja.aliasing.unique-table',
					message: `Duplicate table alias '${label}'.`,
					range: new vscode.Range(line, col, line, endCol),
				});
			} else {
				seen.set(key, { line, col });
			}
		}

		return violations;
	},
};
