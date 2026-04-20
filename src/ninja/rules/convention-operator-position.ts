import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runSpacingEngine } from '../layout/spacing-engine';
import { OPERATOR_SPEC } from '../layout/spacing-specs';

/**
 * Enforces consistent boolean operator placement (trailing or leading).
 *
 * Delegates to the spacing engine so the line-position fix logic is shared
 * with other layout rules (comma-position, set-operator, clause-keyword).
 */
export const operatorPositionRule: TokenRule = {
	id: 'ninja.convention.operator-position',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent boolean operator placement (trailing or leading).',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'layout.operatorPosition', label: 'Position', type: 'enum', choices: ['trailing', 'leading'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const events = runSpacingEngine(
			model.ninjaSqlTokens,
			document,
			config,
			[OPERATOR_SPEC],
			'ninja.convention.operator-position',
		);

		return events
			.filter(e => e.kind === 'line-position')
			.map(e => ({
				rule: 'ninja.convention.operator-position',
				message: e.message,
				range: e.range,
				...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
			}));
	},
};
