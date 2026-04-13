import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';

/** LT15: There should be at most one consecutive blank line. */
export const maxBlankLinesRule: LayoutRule = {
	id: 'ninja.layout.max-blank-lines',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'There should be at most one consecutive blank line',

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		let consecutiveBlanks = 0;
		let blankStart = -1;

		for (let i = 0; i < ctx.lines.length; i++) {
			const trimmed = ctx.lines[i].trim();
			if (trimmed === '' || trimmed === '\r') {
				if (consecutiveBlanks === 0) blankStart = i;
				consecutiveBlanks++;
			} else {
				if (consecutiveBlanks > 1) {
					// Keep one blank line, delete the extras
					const range = new vscode.Range(blankStart + 1, 0, blankStart + consecutiveBlanks, 0);
					violations.push({
						rule: 'ninja.layout.max-blank-lines',
						message: `${consecutiveBlanks} consecutive blank lines (max 1)`,
						range,
						fix: [vscode.TextEdit.delete(range)],
					});
				}
				consecutiveBlanks = 0;
			}
		}

		// Handle trailing consecutive blanks (before EOF)
		if (consecutiveBlanks > 1) {
			const range = new vscode.Range(blankStart + 1, 0, blankStart + consecutiveBlanks, 0);
			violations.push({
				rule: 'ninja.layout.max-blank-lines',
				message: `${consecutiveBlanks} consecutive blank lines (max 1)`,
				range,
				fix: [vscode.TextEdit.delete(range)],
			});
		}

		return violations;
	},
};
