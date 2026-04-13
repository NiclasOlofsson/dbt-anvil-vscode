import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';

/** LT13: Files should not start with blank/whitespace-only lines. */
export const leadingWhitespaceRule: LayoutRule = {
	id: 'ninja.layout.leading-whitespace',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'Files should not start with blank lines',

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];

		// Find the first non-blank line
		let firstNonBlank = 0;
		while (firstNonBlank < ctx.lines.length && ctx.lines[firstNonBlank].trim() === '') {
			firstNonBlank++;
		}

		if (firstNonBlank > 0 && firstNonBlank < ctx.lines.length) {
			const range = new vscode.Range(0, 0, firstNonBlank, 0);
			violations.push({
				rule: 'ninja.layout.leading-whitespace',
				message: 'File should not start with blank lines',
				range,
				fix: [vscode.TextEdit.delete(range)],
			});
		}

		return violations;
	},
};
