import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runSpacingEngine } from '../layout/spacing-engine';
import { OPEN_PAREN_SPEC, CLOSE_PAREN_SPEC } from '../layout/spacing-specs';

/**
 * Enforces consistent spacing around brackets.
 *
 * Rules (matching sqlfluff LT01):
 *   - No space between `(` and the next token: `count( * )` → `count(*)`
 *   - No space between the previous token and `)`: `count( * )` → `count(*)`
 *
 * Function-name-to-paren spacing is handled separately by
 * `ninja.layout.function_spacing`. This rule only concerns the space
 * *inside* parentheses.
 */
export const bracketSpacingRule: TokenRule = {
	id: 'ninja.layout.spacing',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'No space immediately after `(` or before `)`.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const events = runSpacingEngine(
			model.ninjaSqlTokens,
			document,
			config,
			[OPEN_PAREN_SPEC, CLOSE_PAREN_SPEC],
			'ninja.layout.spacing',
		);

		return events
			.filter(e => e.kind === 'spacing')
			.map(e => ({
				rule: 'ninja.layout.spacing',
				message: e.message,
				range: e.range,
				...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
			}));
	},
};
