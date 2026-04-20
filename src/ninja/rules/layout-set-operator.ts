import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runSpacingEngine } from '../layout/spacing-engine';
import { SET_OPERATOR_SPEC } from '../layout/spacing-specs';

/**
 * UNION / UNION ALL / INTERSECT / EXCEPT must each appear alone on their own line.
 *
 * Correct:
 *   select a from t1
 *   union all
 *   select a from t2
 *
 * Violation:
 *   select a from t1 union all select a from t2
 *
 * Note: this rule concerns line position only; `ninja.ambiguity.bare-union`
 * handles the distinct vs all qualification separately.
 */
export const setOperatorRule: TokenRule = {
	id: 'ninja.layout.set-operator',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'UNION / UNION ALL / INTERSECT / EXCEPT must be on their own line.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const events = runSpacingEngine(
			model.ninjaSqlTokens,
			document,
			config,
			[SET_OPERATOR_SPEC],
			'ninja.layout.set-operator',
		);

		return events
			.filter(e => e.kind === 'line-position')
			.map(e => ({
				rule: 'ninja.layout.set-operator',
				message: e.message,
				range: e.range,
				...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
			}));
	},
};
