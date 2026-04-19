import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { tokenRange, tokenText } from '../token-utils';

const JOIN_QUALIFIERS = new Set(['INNER', 'LEFT', 'RIGHT', 'CROSS', 'FULL', 'NATURAL']);

export const implicitJoinRule: TokenRule = {
	id: 'ninja.ambiguity.implicit-join',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'warning',
	description: 'Use explicit JOIN qualifiers (INNER, LEFT, etc.) instead of bare JOIN.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'JOIN') continue;

			const prev = tokens[i - 1];
			if (prev && JOIN_QUALIFIERS.has(prev.type)) continue;

			const tok = tokens[i];
			const raw = tokenText(text, tok);
			const range = tokenRange(text, tok);
			violations.push({
				rule: 'ninja.ambiguity.implicit-join',
				message: 'Use INNER JOIN instead of bare JOIN.',
				range,
				action: { type: FixAction.TYPE, edits: [{ range, newText: `INNER ${raw}` }], autoFix: true },
			});
		}

		return violations;
	},
};
