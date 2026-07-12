import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import { normaliseArgumentSpacing } from '../jinja/tag-formatter';
import { replaceOp } from '../fix-op';

const RULE_ID = 'ninja.jinja.argument-spacing';

/**
 * JJ02: Jinja tag ARGUMENT spacing.
 *
 * Checks:
 *   - Single space after each comma in function arguments: `ref('a','b')` -> `ref('a', 'b')`
 *   - No spaces around `=` in keyword arguments: `package = 'p'` -> `package='p'`
 *
 * Delimiter padding is NOT this rule's concern; `ninja.jinja.padding` owns that,
 * so the two rules never overlap. String literal contents are never modified.
 * Newline-aware: line breaks and indentation inside a multiline tag are
 * preserved, and a comma at end of line gets no trailing space.
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

		// Pre-compute SQL comment byte ranges. The jinja tokenizer is
		// comment-agnostic and happily flags `{{ ... }}` patterns that appear
		// inside `-- ...` or `/* ... */` SQL comments — but the formatter
		// emits those comments verbatim (and never re-normalises the embedded
		// Jinja). Flagging would produce ghost violations on the formatter's
		// own output.
		const commentRanges: Array<{ start: number; end: number }> = [];
		for (const tok of tokens) {
			if (tok.category !== 'sql' || !tok.comments?.length) continue;
			for (const c of tok.comments) commentRanges.push({ start: c.start, end: c.end });
		}
		const isInsideComment = (offset: number): boolean => {
			for (const r of commentRanges) {
				if (offset >= r.start && offset < r.end) return true;
			}
			return false;
		};

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

			// Skip Jinja tags whose span sits inside a SQL comment — the
			// formatter emits the comment verbatim and never re-normalises
			// the embedded Jinja, so the rule would fire on its own output.
			if (isInsideComment(token.start)) continue;

			// Extract the full raw tag text from the document source.
			const raw = text.slice(token.start, tagEnd);
			const normalised = normaliseArgumentSpacing(raw);
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
