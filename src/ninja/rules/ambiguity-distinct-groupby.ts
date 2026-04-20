import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const distinctGroupByRule: TokenRule = {
	id: 'ninja.ambiguity.distinct-groupby',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'info',
	description: 'Using DISTINCT with GROUP BY is redundant.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();

		let distinctToken = null;
		let hasGroupBy = false;

		for (const tok of tokens) {
			if (tok.type === 'DISTINCT' && !distinctToken) distinctToken = tok;
			if (tok.type === 'GROUP') hasGroupBy = true;
		}

		if (!distinctToken || !hasGroupBy) return [];

		const range = tokenRange(text, distinctToken);

		return [{
			rule: 'ninja.ambiguity.distinct-groupby',
			message: 'DISTINCT is redundant when GROUP BY is present.',
			range,
		}];
	},
};
