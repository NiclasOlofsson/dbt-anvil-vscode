import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { tokenRange, tokenText } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const bareUnionRule: TokenRule = {
	id: 'ninja.ambiguity.bare-union',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'warning',
	description: 'Use UNION ALL or UNION DISTINCT explicitly — bare UNION is ambiguous.',
	actionKinds: ['fix'],
	autoFixable: true,
	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'UNION') continue;

			const next = tokens[i + 1];
			if (next && (next.type === 'ALL' || next.type === 'DISTINCT')) continue;

			const tok = tokens[i];
			const raw = tokenText(text, tok);
			const range = tokenRange(text, tok);
			const suffix = config.convention.unionStyle.toUpperCase();
			violations.push({
				rule: 'ninja.ambiguity.bare-union',
				message: `Use UNION ${suffix} instead of bare UNION.`,
				range,
				action: { type: FixAction.TYPE, edits: [{ range, newText: `${raw} ${suffix}` }], autoFix: true },
			});
		}

		return violations;
	},
};
