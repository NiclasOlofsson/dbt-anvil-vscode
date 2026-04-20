import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import { normaliseTagSpacing } from '../jinja/tag-formatter';
import { replaceOp } from '../fix-op';

const RULE_ID = 'ninja.jinja.argument-spacing';

/**
 * JJ02: Jinja tags should have normalised internal spacing.
 *
 * Checks:
 *   - Single space after each comma in function arguments: `ref('a','b')` → `ref('a', 'b')`
 *   - No spaces around `=` in keyword arguments: `package = 'p'` → `package='p'`
 *   - Single space inside delimiters: `{{x}}` → `{{ x }}`
 *   - Single space after whitespace-control dashes: `{{-x-}}` → `{{- x -}}`
 *
 * String literal contents are never modified.
 * Multiline tags are skipped — newlines inside a tag are intentional formatting.
 */
export const jinjaArgumentSpacingRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Jinja,
	defaultSeverity: 'hint',
	description: 'Jinja tags should have normalised internal spacing (commas, kwargs, delimiter padding)',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const tokens = ctx.model.ninjaSqlTokens ?? [];
		const text = ctx.document.getText();

		for (const token of tokens) {
			if (token.category !== 'jinja') continue;

			// Only process whole-tag open tokens — they carry `tagEnd` which
			// marks the exclusive end of the full tag in the source.
			if (
				token.type !== 'jinja_expression_open' &&
				token.type !== 'jinja_block_open'
			) {
				continue;
			}

			const tagEnd = token.tagEnd;
			if (tagEnd === undefined) continue;

			// Extract the full raw tag text from the document source.
			const raw = text.slice(token.start, tagEnd);
			const normalised = normaliseTagSpacing(raw);
			if (normalised === null) continue; // already correct

			const startPos = ctx.document.positionAt(token.start);
			const endPos = ctx.document.positionAt(tagEnd);
			const range = new vscode.Range(startPos, endPos);

			violations.push({
				rule: RULE_ID,
				message: `Jinja tag spacing can be normalised: ${raw} → ${normalised}`,
				range,
				action: {
					type: FixAction.TYPE,
					ops: [replaceOp(range, normalised)],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};
