import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';
import { tokenText, tokenRange } from '../token-utils';

// Boolean/null literals that should follow capitalisation policy.
// These token types are emitted by sqlglot and never appear inside SQL comments.
const LITERAL_TOKEN_TYPES = new Set(['null', 'true', 'false']);

function checkPolicy(word: string, policy: CapitalisationPolicy, expected: Map<string, string>): string | undefined {
	if (policy === 'upper') {
		const upper = word.toUpperCase();
		return word !== upper ? upper : undefined;
	}
	if (policy === 'lower') {
		const lower = word.toLowerCase();
		return word !== lower ? lower : undefined;
	}
	const key = word.toLowerCase();
	const first = expected.get(key);
	if (!first) {
		expected.set(key, word);
		return undefined;
	}
	return word !== first ? first : undefined;
}

export const literalCapRule: TokenRule = {
	id: 'ninja.cap.literals',
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'warning',
	description: 'SQL literals (NULL, TRUE, FALSE) should follow the configured capitalisation policy',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.literals;
		const violations: NinjaViolation[] = [];
		const consistentMap = new Map<string, string>();

		if (!ctx.model.sqlTokens) return violations;

		const text = ctx.document.getText();

		for (const token of ctx.model.sqlTokens) {
			if (!LITERAL_TOKEN_TYPES.has(token.type.toLowerCase())) continue;

			const word = tokenText(text, token);
			const fix = checkPolicy(word, policy, consistentMap);
			if (fix !== undefined) {
				const range = tokenRange(text, token);
				violations.push({
					rule: 'ninja.cap.literals',
					message: `Expected literal '${word}' to be '${fix}'`,
					range,
					action: { type: FixAction.TYPE, edits: [vscode.TextEdit.replace(range, fix)], autoFix: true },
				});
			}
		}

		return violations;
	},
};
