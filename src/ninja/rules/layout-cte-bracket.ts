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
			// non-whitespace content before OR after the ) on closingLine.
			// Both directions matter: text before means the body's last token
			// shares the line with the close paren; text after means the
			// next CTE (or the final select) starts on the same line as the
			// close paren — e.g. `), b as (`. Either way the ) is not alone.
			if (closingLine >= document.lineCount) continue;
			const lineText = document.lineAt(closingLine).text;
			const endCol = cte.endCol ?? lineText.length;
			// Text on the closing-paren line before the )
			const before = lineText.slice(0, endCol - 1).trimEnd();
			// Text on the closing-paren line after the ) — comma, whitespace,
			// and the next CTE's leading tokens count. A bare comma is also
			// a violation because the canonical form keeps the comma on its
			// own line (or, equivalently, on the close-paren line so long as
			// nothing else follows).
			const after = lineText.slice(endCol).replace(/^\s*,?\s*/, '').trimEnd();
			if (before.length > 0 || after.length > 0) {
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
