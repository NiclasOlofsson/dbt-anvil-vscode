import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { replaceOp } from '../fix-op';
import { tokenRange, tokenText } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

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
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
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
				action: { type: FixAction.TYPE, ops: [replaceOp(range, `INNER ${raw}`)], autoFix: true },
			});
		}

		return violations;
	},
};
