import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const RULE_ID = 'ninja.convention.explicit-inner-join';

const JOIN_QUALIFIERS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER']);

export const explicitInnerJoinRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'info',
	description: 'Write INNER JOIN instead of bare JOIN to make intent explicit.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		if (!ctx.config.convention.explicitInnerJoin) return [];

		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];
			if (tok.type !== 'JOIN') continue;

			// A bare JOIN is one not preceded by a join qualifier.
			const prev = i > 0 ? tokens[i - 1] : undefined;
			if (prev && JOIN_QUALIFIERS.has(prev.type)) continue;

			const range = tokenRange(text, tok);
			violations.push({
				rule: RULE_ID,
				message: 'Use INNER JOIN instead of bare JOIN to make intent explicit.',
				range,
				action: {
					type: FixAction.TYPE,
					edits: [{ range, newText: 'INNER JOIN' }],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};
