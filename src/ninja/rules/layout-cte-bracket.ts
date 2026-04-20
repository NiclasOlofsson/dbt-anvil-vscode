import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';

export const cteBracketRule: TokenRule = {
	id: 'ninja.layout.cte-bracket',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'Closing ) of a CTE body must be on its own line (LT07)',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.ctes?.length) return [];

		const violations: NinjaViolation[] = [];

		for (const cte of model.ctes) {
			if (cte.isSubquery) continue;

			const closingLine = cte.endLine;

			// If opening paren and closing paren are on the same line as the CTE
			// name, the body is entirely on one line — always a violation.
			if (closingLine === cte.line) {
				if (closingLine >= document.lineCount) continue;
				const endCol = cte.endCol ?? document.lineAt(closingLine).text.length;
				const range = new vscode.Range(closingLine, endCol - 1, closingLine, endCol);
				violations.push({
					rule: 'ninja.layout.cte-bracket',
					message: `CTE '${cte.name}': closing ) must be on its own line`,
					range,
				});
				continue;
			}

			// The body spans multiple lines. Check whether there is any
			// non-whitespace content before the ) on closingLine.
			if (closingLine >= document.lineCount) continue;
			const lineText = document.lineAt(closingLine).text;
			const endCol = cte.endCol ?? lineText.length;
			// Text on the closing-paren line before the )
			const before = lineText.slice(0, endCol - 1).trimEnd();
			if (before.length > 0) {
				const range = new vscode.Range(closingLine, endCol - 1, closingLine, endCol);
				violations.push({
					rule: 'ninja.layout.cte-bracket',
					message: `CTE '${cte.name}': closing ) must be on its own line`,
					range,
				});
			}
		}

		return violations;
	},
};
