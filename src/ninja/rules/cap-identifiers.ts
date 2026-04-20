import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import { tokenText, tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const RULE_ID = 'ninja.cap.identifiers';

// sqlglot token types that represent unquoted identifiers.
const IDENTIFIER_TYPES = new Set(['VAR', 'IDENTIFIER']);

// sqlglot token types that represent quoted identifiers — skip these.
const QUOTED_TYPES = new Set(['QUOTED_IDENTIFIER', 'BACKTICK']);

/**
 * Detect whether an identifier is mixed-case (has both upper and lower chars),
 * which is always flagged regardless of the established policy.
 */
function isMixedCase(word: string): boolean {
	return word !== word.toUpperCase() && word !== word.toLowerCase();
}

export const capIdentifiersRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'hint',
	description: 'Unquoted identifiers should follow a consistent capitalisation policy (all uppercase or all lowercase)',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const sqlTokens = sqlOnly(ctx.model.ninjaSqlTokens);
		if (sqlTokens.length === 0) return violations;

		const text = ctx.document.getText();

		// The first unquoted non-trivial identifier seen sets the expected policy:
		// 'upper' if it's all uppercase, 'lower' if it's all lowercase.
		// Mixed-case identifiers are always flagged.
		let policy: 'upper' | 'lower' | undefined;

		for (const token of sqlTokens) {
			// Only process unquoted identifier token types.
			if (!IDENTIFIER_TYPES.has(token.type) && !QUOTED_TYPES.has(token.type)) continue;
			// Skip quoted identifiers — their casing is intentional.
			if (QUOTED_TYPES.has(token.type)) continue;

			const word = tokenText(text, token);

			// Skip single-character identifiers — these are conventional short aliases.
			if (word.length <= 1) continue;

			// Mixed-case identifiers are always flagged.
			if (isMixedCase(word)) {
				const range = tokenRange(text, token);
				violations.push({
					rule: RULE_ID,
					message: `Identifier '${word}' is mixed-case; identifiers should be consistently all uppercase or all lowercase`,
					range,
				});
				continue;
			}

			const isUpper = word === word.toUpperCase();

			if (policy === undefined) {
				// First identifier sets the policy.
				policy = isUpper ? 'upper' : 'lower';
				continue;
			}

			const expected = policy === 'upper';
			if (isUpper !== expected) {
				const fix = policy === 'upper' ? word.toUpperCase() : word.toLowerCase();
				const range = tokenRange(text, token);
				violations.push({
					rule: RULE_ID,
					message: `Expected identifier '${word}' to be '${fix}' (consistent with first identifier's case)`,
					range,
				});
			}
		}

		return violations;
	},
};
