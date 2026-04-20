import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';

export const cteBlankLineRule: TokenRule = {
	id: 'ninja.layout.cte-blank-line',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'There should be a blank line between CTE definitions (LT08)',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.ctes || model.ctes.length < 2) return [];

		const violations: NinjaViolation[] = [];

		// Only check between consecutive non-subquery CTEs.
		// The last CTE has no subsequent CTE, so no blank line is required after it.
		for (let i = 0; i < model.ctes.length - 1; i++) {
			const curr = model.ctes[i];
			const next = model.ctes[i + 1];

			if (curr.isSubquery || next.isSubquery) continue;

			// curr ends at endLine. The comma separator lives on endLine (trailing
			// comma style) or on endLine right after the ). The next CTE name is at
			// next.line. For a blank line to exist there must be at least one
			// completely empty line between curr.endLine and next.line.
			const gapStart = curr.endLine + 1; // first line after closing paren
			const gapEnd = next.line;           // line the next CTE name is on

			// No lines in between at all → definitely no blank line
			if (gapEnd <= gapStart) {
				const col = next.col ?? 0;
				violations.push({
					rule: 'ninja.layout.cte-blank-line',
					message: `Missing blank line before CTE '${next.name}'`,
					range: new vscode.Range(next.line, col, next.line, col + next.name.length),
				});
				continue;
			}

			// Check whether any line in the gap is blank (whitespace-only)
			let hasBlankLine = false;
			for (let l = gapStart; l < gapEnd; l++) {
				if (l >= document.lineCount) break;
				if (document.lineAt(l).text.trim() === '') {
					hasBlankLine = true;
					break;
				}
			}

			if (!hasBlankLine) {
				const col = next.col ?? 0;
				violations.push({
					rule: 'ninja.layout.cte-blank-line',
					message: `Missing blank line before CTE '${next.name}'`,
					range: new vscode.Range(next.line, col, next.line, col + next.name.length),
				});
			}
		}

		return violations;
	},
};
