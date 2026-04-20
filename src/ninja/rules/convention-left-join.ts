import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const leftJoinRule: TokenRule = {
	id: 'ninja.convention.left-join',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Prefer LEFT JOIN over RIGHT JOIN for readability.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length - 1; i++) {
			if (tokens[i].type !== 'RIGHT') continue;
			if (tokens[i + 1].type !== 'JOIN') continue;

			const range = tokenRange(text, tokens[i]);
			violations.push({
				rule: 'ninja.convention.left-join',
				message: 'Prefer LEFT JOIN over RIGHT JOIN — reorder tables instead.',
				range,
			});
		}

		return violations;
	},
};
