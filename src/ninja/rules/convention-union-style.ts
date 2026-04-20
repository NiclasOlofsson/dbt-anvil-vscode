import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { replaceOp } from '../fix-op';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const unionStyleRule: TokenRule = {
	id: 'ninja.convention.union-style',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent UNION qualifier style (ALL vs DISTINCT).',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'convention.unionStyle', label: 'Preferred', type: 'enum', choices: ['all', 'distinct'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];
		const preferred = config.convention.unionStyle; // 'all' | 'distinct'

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'UNION') continue;

			const next = tokens[i + 1];
			if (!next) continue;
			if (next.type !== 'ALL' && next.type !== 'DISTINCT') continue;

			const actual = next.type.toLowerCase() as 'all' | 'distinct';
			if (actual === preferred) continue;

			const range = tokenRange(text, next);

			violations.push({
				rule: 'ninja.convention.union-style',
				message: `Use UNION ${preferred.toUpperCase()} — UNION ${actual.toUpperCase()} conflicts with the configured style.`,
				range,
				action: { type: FixAction.TYPE, ops: [replaceOp(range, preferred.toUpperCase())], autoFix: true },
			});
		}

		return violations;
	},
};
