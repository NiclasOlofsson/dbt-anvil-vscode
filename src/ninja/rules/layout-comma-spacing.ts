import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runSpacingEngine } from '../layout/spacing-engine';
import { COMMA_SPACING_SPEC } from '../layout/spacing-specs';

/**
 * Enforces no space before a comma, and exactly one space after.
 *
 * Cross-line commas (leading-comma style) are intentionally untouched —
 * the spacing engine's same-line guard skips them, and comma placement
 * across lines is owned by `ninja.convention.comma-position`.
 */
export const commaSpacingRule: TokenRule = {
	id: 'ninja.layout.comma-spacing',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'No space before a comma, exactly one space after.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const events = runSpacingEngine(
			model.ninjaSqlTokens,
			document,
			config,
			[COMMA_SPACING_SPEC],
			'ninja.layout.comma-spacing',
		);
		return events
			.filter(e => e.kind === 'spacing')
			.map(e => ({
				rule: 'ninja.layout.comma-spacing',
				message: e.message,
				range: e.range,
				...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
			}));
	},
};
