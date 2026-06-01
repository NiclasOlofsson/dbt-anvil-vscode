import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';
import { deleteOp } from '../fix-op';

/** LT15: There should be at most N consecutive blank lines (configurable, default 2). */
export const maxBlankLinesRule: LayoutRule = {
	id: 'ninja.layout.max-blank-lines',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'There should be at most N consecutive blank lines',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'maxBlankLines', label: 'Max lines', type: 'number', min: 1, max: 10 }],

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
						action: { type: FixAction.TYPE, ops: [deleteOp(range)], autoFix: true },
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
