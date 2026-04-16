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
	fixes: 'auto',

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const text = ctx.text;

		if (text.length === 0) return [];

		// Find where trailing whitespace (newlines, spaces, CR) begins.
		// Everything from that point to EOF should be exactly '\n'.
		const trimLen = text.trimEnd().length;
		const tail = text.slice(trimLen);

		const eol = text.includes('\r\n') ? '\r\n' : '\n';

		if (tail === eol) return [];

		const fixStart = ctx.document.positionAt(trimLen);
		const fixEnd = ctx.document.positionAt(text.length);
		const fixRange = new vscode.Range(fixStart, fixEnd);

		// Point the squiggle at the excess beyond the first newline (when one is present),
		// or at the end of file when the trailing newline is missing entirely.
		const squiggleOffset = tail.startsWith(eol) ? trimLen + eol.length : trimLen;
		const diagnosticRange = new vscode.Range(ctx.document.positionAt(squiggleOffset), fixEnd);

		const message = tail === ''
			? 'File should end with a trailing newline'
			: 'File should end with exactly one trailing newline';

		return [{
			rule: 'ninja.layout.trailing-newline',
			message,
			range: diagnosticRange,
			fix: [vscode.TextEdit.replace(fixRange, eol)],
		}];
	},
};
