import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runSpacingEngine } from '../layout/spacing-engine';
import { COMMA_SPEC } from '../layout/spacing-specs';

/**
 * Enforces consistent comma placement (trailing or leading).
 *
 * Delegates detection and fix-building to the spacing engine so the line-
 * position logic is shared with other layout rules (operator-position, set-
 * operator, clause-keyword) without duplication. Engine events are filtered
 * to this rule's diagnostic tag.
 */
export const commaPositionRule: TokenRule = {
	id: 'ninja.convention.comma-position',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent comma placement (trailing or leading).',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'layout.commaPosition', label: 'Position', type: 'enum', choices: ['trailing', 'leading'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const events = runSpacingEngine(
			model.ninjaSqlTokens,
			document,
			config,
			[COMMA_SPEC],
			'ninja.convention.comma-position',
		);

		return events
			.filter(e => e.kind === 'line-position')
			.map(e => ({
				rule: 'ninja.convention.comma-position',
				message: e.message,
				range: e.range,
				...(e.fix ? { action: { type: 'fix' as const, edits: e.fix.edits, autoFix: e.fix.autoFix } } : {}),
			}));
	},
};
