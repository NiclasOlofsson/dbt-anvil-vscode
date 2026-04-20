import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const onVsUsingRule: TokenRule = {
	id: 'ninja.structure.on-vs-using',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'hint',
	description: 'Prefer JOIN ... ON condition over USING(...) for explicitness.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of tokens) {
			if (tok.type !== 'USING') continue;
			violations.push({
				rule: 'ninja.structure.on-vs-using',
				message: 'Prefer JOIN ... ON condition over USING(...).',
				range: tokenRange(text, tok),
			});
		}

		return violations;
	},
};
