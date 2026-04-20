import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import { tokenText, tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const RULE_ID = 'ninja.alias.length';

export const aliasLengthRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'hint',
	description: 'Table aliases should be at least 2 characters long',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const sqlTokens = sqlOnly(ctx.model.ninjaSqlTokens);
		if (sqlTokens.length === 0) return violations;

		const text = ctx.document.getText();

		// Walk the token stream. When an AS keyword is found, check the following
		// VAR/IDENTIFIER token. Flag it if it is a single character.
		for (let i = 0; i < sqlTokens.length - 1; i++) {
			const tok = sqlTokens[i];
			if (tok.type.toLowerCase() !== 'as') continue;

			const next = sqlTokens[i + 1];
			if (next.type !== 'VAR' && next.type !== 'IDENTIFIER') continue;

			const alias = tokenText(text, next);
			if (alias.length < 2) {
				const range = tokenRange(text, next);
				violations.push({
					rule: RULE_ID,
					message: `Table alias '${alias}' is too short; aliases should be at least 2 characters`,
					range,
				});
			}
		}

		return violations;
	},
};
