import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

/**
 * Flags column aliases that omit the `AS` keyword.
 *
 * Uses model.finalSelect columns and sqlTokens to detect implicit aliases.
 * For each aliased column, checks whether an ALIAS (= AS keyword) sqlToken
 * exists between the expression and the alias identifier.
 */
export const columnAsRule: TokenRule = {
	id: 'ninja.aliasing.column-as',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'info',
	description: 'Column aliases should use explicit AS keyword.',
	fixes: 'auto',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		if (!model.finalSelect) return [];
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const aliasTokens = model.sqlTokens.filter(t => t.type === 'ALIAS');
		const violations: NinjaViolation[] = [];

		for (const col of model.finalSelect.columns) {
			if (col.aliasLine === undefined || col.aliasCol === undefined || col.aliasEndCol === undefined) continue;

			// Look for an ALIAS token between expression end and alias start
			const hasAs = aliasTokens.some(t => {
				if (t.line < col.line || t.line > col.aliasLine!) return false;
				if (t.line === col.line && t.line === col.aliasLine!) {
					// Single line: AS must be between expression end and alias start.
					// Use t.col (0-based exclusive end column, line-relative) not t.end
					// (absolute char offset) — they only coincide on line 0.
					return t.col <= col.aliasCol!;
				}
				// Multi-line: AS on any intermediate line or at acceptable position on boundary lines
				return true;
			});

			if (!hasAs) {
				const range = new vscode.Range(
					col.aliasLine, col.aliasCol,
					col.aliasLine, col.aliasEndCol,
				);
				violations.push({
					rule: 'ninja.aliasing.column-as',
					message: `Column alias '${col.name}' should use explicit AS keyword.`,
					range,
					fix: [vscode.TextEdit.insert(new vscode.Position(col.aliasLine, col.aliasCol), 'AS ')],
				});
			}
		}

		return violations;
	},
};
