import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';

/** LT01: Lines should not have trailing whitespace. */
export const trailingWhitespaceRule: LayoutRule = {
	id: 'ninja.layout.trailing-whitespace',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'Lines should not have trailing whitespace',

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < ctx.lines.length; i++) {
			const line = ctx.lines[i];
			if (line.length === 0) continue;

			let end = line.length;
			// Handle \r at end of line (CRLF files split on \n leave \r)
			if (line[end - 1] === '\r') end--;
			if (end === 0) continue;

			let trailStart = end;
			while (trailStart > 0 && (line[trailStart - 1] === ' ' || line[trailStart - 1] === '\t')) {
				trailStart--;
			}

			if (trailStart < end) {
				const range = new vscode.Range(i, trailStart, i, end);
				violations.push({
					rule: 'ninja.layout.trailing-whitespace',
					message: 'Trailing whitespace',
					range,
					action: { type: FixAction.TYPE, edits: [vscode.TextEdit.delete(range)], autoFix: true },
				});
			}
		}

		return violations;
	},
};
