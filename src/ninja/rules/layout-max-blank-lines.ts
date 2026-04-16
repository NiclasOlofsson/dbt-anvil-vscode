import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';

/** LT15: There should be at most N consecutive blank lines (configurable, default 2). */
export const maxBlankLinesRule: LayoutRule = {
	id: 'ninja.layout.max-blank-lines',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'There should be at most N consecutive blank lines',

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const max = ctx.config.maxBlankLines;
		let consecutiveBlanks = 0;
		let blankStart = -1;

		for (let i = 0; i < ctx.lines.length; i++) {
			const trimmed = ctx.lines[i].trim();
			if (trimmed === '' || trimmed === '\r') {
				if (consecutiveBlanks === 0) blankStart = i;
				consecutiveBlanks++;
			} else {
				if (consecutiveBlanks > max) {
					// Keep `max` blank lines, delete the extras
					const range = new vscode.Range(blankStart + max, 0, blankStart + consecutiveBlanks, 0);
					violations.push({
						rule: 'ninja.layout.max-blank-lines',
						message: `${consecutiveBlanks} consecutive blank lines (max ${max})`,
						range,
						action: { type: FixAction.TYPE, edits: [vscode.TextEdit.delete(range)], autoFix: true },
					});
				}
				consecutiveBlanks = 0;
			}
		}

		// Trailing blank lines at EOF are owned by ninja.layout.trailing-newline.
		// Do not emit a violation here to avoid overlapping fix ranges.

		return violations;
	},
};
