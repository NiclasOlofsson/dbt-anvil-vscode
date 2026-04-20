import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { LayoutRule, LayoutRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { replaceOp } from '../fix-op';

/**
 * Comment-only lines should be indented to match the following code line.
 *
 * "Comment-only line" = a line whose first non-whitespace characters are `--`
 * (trailing comments on code lines are not flagged — those are handled by the
 * trailing-whitespace rule when needed).
 *
 * Column 0 is always valid — section-header comments anchored to the left
 * margin are a common and legitimate style.
 *
 * Reference for indentation = the leading whitespace of the first following
 * non-comment, non-blank, non-jinja-internal line. Falls back to the previous
 * code line for comments at end-of-file.
 */
export const indentCommentsRule: LayoutRule = {
	id: 'ninja.layout.indent-comments',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'Standalone comment lines should match the indent of surrounding code.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const { lines } = ctx;
		const violations: NinjaViolation[] = [];

		// Lines that sit INSIDE a multi-line jinja token — these follow
		// jinja's own formatting, not SQL indent conventions.
		const jinjaInternal = new Set<number>();
		for (const tok of ctx.jinjaTokens) {
			const startLine = ctx.document.positionAt(tok.start).line;
			const endLine = ctx.document.positionAt(tok.end).line;
			for (let l = startLine + 1; l < endLine; l++) jinjaInternal.add(l);
		}

		for (let i = 0; i < lines.length; i++) {
			if (jinjaInternal.has(i)) continue;
			const line = lines[i];
			const trimmed = line.trimStart();
			if (!trimmed.startsWith('--')) continue;

			const actualIndent = line.length - trimmed.length;
			// Col 0 escape hatch: section-header comments at left margin are always valid.
			if (actualIndent === 0) continue;

			const refLeading = findReferenceLeadingWs(lines, i, jinjaInternal);
			if (refLeading === undefined) continue;

			const actualLeading = line.slice(0, actualIndent);
			if (actualLeading === refLeading) continue;

			const range = new vscode.Range(i, 0, i, actualIndent);
			violations.push({
				rule: 'ninja.layout.indent-comments',
				message: `Comment should be indented to column ${refLeading.length} to match surrounding code (currently column ${actualIndent}).`,
				range,
				action: {
					type: FixAction.TYPE,
					ops: [replaceOp(range, refLeading)],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};

/**
 * Find the leading whitespace of the first non-comment, non-blank code line
 * following `i`. Falls back to the previous code line when none follows.
 */
function findReferenceLeadingWs(
	lines: string[],
	i: number,
	jinjaInternal: Set<number>,
): string | undefined {
	for (let j = i + 1; j < lines.length; j++) {
		if (jinjaInternal.has(j)) continue;
		const trimmed = lines[j].trimStart();
		if (trimmed.length === 0) continue;
		if (trimmed.startsWith('--')) continue;
		return lines[j].slice(0, lines[j].length - trimmed.length);
	}
	for (let j = i - 1; j >= 0; j--) {
		if (jinjaInternal.has(j)) continue;
		const trimmed = lines[j].trimStart();
		if (trimmed.length === 0) continue;
		if (trimmed.startsWith('--')) continue;
		return lines[j].slice(0, lines[j].length - trimmed.length);
	}
	return undefined;
}
