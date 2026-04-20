import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';

const RULE_ID = 'ninja.alias.unique-columns';

export const aliasUniqueColumnsRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'warning',
	description: 'Column aliases in a SELECT clause must be unique',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		// Use the rich finalSelect data when available — each column entry carries
		// its alias line/col so we can point directly at the alias identifier.
		if (model.finalSelect) {
			const seen = new Map<string, { line: number; col: number; endCol: number }>();

			for (const col of model.finalSelect.columns) {
				const key = col.name.toLowerCase();

				// Prefer the alias position if an explicit AS alias was written.
				const line = col.aliasLine ?? col.line;
				const colStart = col.aliasCol ?? col.col;
				const colEnd = col.aliasEndCol ?? col.endCol;

				const prev = seen.get(key);
				if (prev) {
					violations.push({
						rule: RULE_ID,
						message: `Duplicate column alias '${col.name}' in SELECT clause`,
						range: new vscode.Range(line, colStart, line, colEnd),
					});
				} else {
					seen.set(key, { line, col: colStart, endCol: colEnd });
				}
			}

			return violations;
		}

		// Fallback: use model.finalColumns (less positional detail).
		if (model.finalColumns.length === 0) return violations;

		const seen = new Map<string, { line: number; col: number }>();
		for (const col of model.finalColumns) {
			const key = col.name.toLowerCase();
			const colPos = col.col ?? 0;

			const prev = seen.get(key);
			if (prev) {
				violations.push({
					rule: RULE_ID,
					message: `Duplicate column alias '${col.name}' in SELECT clause`,
					range: new vscode.Range(col.line, colPos, col.line, colPos + col.name.length),
				});
			} else {
				seen.set(key, { line: col.line, col: colPos });
			}
		}

		return violations;
	},
};
