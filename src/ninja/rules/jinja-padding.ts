import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';

/**
 * JJ01: Jinja tags should have single-space padding inside delimiters.
 * e.g. `{{ref('x')}}` → `{{ ref('x') }}`
 *
 * Checks expression `{{ }}` and tag `{% %}` tokens. Comments `{# #}` are skipped.
 * Whitespace-control dashes (`{{- -}}`, `{%- -%}`) are respected.
 */
export const jinjaPaddingRule: LayoutRule = {
	id: 'ninja.jinja.padding',
	type: 'layout',
	category: NinjaCategory.Jinja,
	defaultSeverity: 'warning',
	description: 'Jinja tags should have single-space padding inside delimiters',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const tokens = ctx.jinjaTokens;

		for (const token of tokens) {
			if (token.type !== 'expression' && token.type !== 'tag') continue;
			// Padding rules don't apply to multiline blocks — a newline after the
			// opening delimiter (or before the closing one) is intentional formatting.
			if (token.raw.includes('\n')) continue;
			const raw = token.raw;
			const openLen = 2; // {{ or {%
			const closeLen = 2; // }} or %}

			// Determine the content boundaries accounting for whitespace-control dashes.
			let contentStart = openLen;
			if (raw[contentStart] === '-') contentStart++;

			let contentEnd = raw.length - closeLen;
			if (raw[contentEnd - 1] === '-') contentEnd--;

			// Check opening padding: should be exactly one space after opener (+ optional dash)
			const afterOpen = raw[contentStart];
			if (afterOpen !== ' ') {
				// Need a space after the opening delimiter
				const pos = ctx.document.positionAt(token.start + contentStart);
				const range = new vscode.Range(pos, pos);
				violations.push({
					rule: 'ninja.jinja.padding',
					message: 'Expected single space after jinja opening delimiter',
					range,
					action: { type: FixAction.TYPE, edits: [vscode.TextEdit.insert(pos, ' ')], autoFix: true },
				});
			} else if (afterOpen === ' ' && raw[contentStart + 1] === ' ') {
				// Multiple spaces — collapse to one
				let spaceEnd = contentStart + 1;
				while (spaceEnd < contentEnd && raw[spaceEnd] === ' ') spaceEnd++;
				if (spaceEnd > contentStart + 1) {
					const startPos = ctx.document.positionAt(token.start + contentStart + 1);
					const endPos = ctx.document.positionAt(token.start + spaceEnd);
					const range = new vscode.Range(startPos, endPos);
					violations.push({
						rule: 'ninja.jinja.padding',
						message: 'Expected single space after jinja opening delimiter',
						range,
						action: { type: FixAction.TYPE, edits: [vscode.TextEdit.delete(range)], autoFix: true },
					});
				}
			}

			// Check closing padding: should be exactly one space before closer (+ optional dash)
			const beforeClose = raw[contentEnd - 1];
			if (beforeClose !== ' ') {
				const pos = ctx.document.positionAt(token.start + contentEnd);
				const range = new vscode.Range(pos, pos);
				violations.push({
					rule: 'ninja.jinja.padding',
					message: 'Expected single space before jinja closing delimiter',
					range,
					action: { type: FixAction.TYPE, edits: [vscode.TextEdit.insert(pos, ' ')], autoFix: true },
				});
			} else if (beforeClose === ' ' && raw[contentEnd - 2] === ' ') {
				// Multiple spaces — collapse to one
				let spaceStart = contentEnd - 2;
				while (spaceStart > contentStart && raw[spaceStart - 1] === ' ') spaceStart--;
				if (spaceStart < contentEnd - 1) {
					const startPos = ctx.document.positionAt(token.start + spaceStart);
					const endPos = ctx.document.positionAt(token.start + contentEnd - 1);
					const range = new vscode.Range(startPos, endPos);
					violations.push({
						rule: 'ninja.jinja.padding',
						message: 'Expected single space before jinja closing delimiter',
						range,
						action: { type: FixAction.TYPE, edits: [vscode.TextEdit.delete(range)], autoFix: true },
					});
				}
			}
		}

		return violations;
	},
};
