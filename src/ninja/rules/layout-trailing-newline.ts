import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';

/** LT12: Files should end with a single trailing newline. */
export const trailingNewlineRule: LayoutRule = {
	id: 'ninja.layout.trailing-newline',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'Files should end with a single trailing newline',

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const text = ctx.text;

		if (text.length === 0) return violations;

		if (text[text.length - 1] !== '\n') {
			// No trailing newline — add one
			const lastLine = ctx.lines.length - 1;
			const lastCol = ctx.lines[lastLine].length;
			const pos = new vscode.Position(lastLine, lastCol);
			violations.push({
				rule: 'ninja.layout.trailing-newline',
				message: 'File should end with a trailing newline',
				range: new vscode.Range(pos, pos),
				fix: [vscode.TextEdit.insert(pos, '\n')],
			});
		} else {
			// Check for multiple trailing newlines
			let i = text.length - 1;
			while (i > 0 && text[i - 1] === '\n') i--;
			// i now points to the last non-newline char + 1 (i.e. first trailing newline)
			const trailingNewlines = text.length - i;
			if (trailingNewlines > 1) {
				// Keep exactly one trailing newline, remove extras
				const startPos = ctx.document.positionAt(i + 1);
				const endPos = ctx.document.positionAt(text.length);
				const range = new vscode.Range(startPos, endPos);
				violations.push({
					rule: 'ninja.layout.trailing-newline',
					message: 'File should end with exactly one trailing newline',
					range,
					fix: [vscode.TextEdit.delete(range)],
				});
			}
		}

		return violations;
	},
};
