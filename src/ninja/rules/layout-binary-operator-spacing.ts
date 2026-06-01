import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runSpacingEngine } from '../layout/spacing-engine';
import { BINARY_OPERATOR_SPEC } from '../layout/spacing-specs';

/**
 * Require a single space on both sides of comparison/equality operators
 * (`=`, `!=`/`<>`, `<`, `<=`, `>`, `>=`).
 *
 * Arithmetic ops (`+`, `-`, `*`, `/`) are deliberately out of scope — `*`
 * is overloaded with SELECT-star, `-` is overloaded with unary negation,
 * and inline arithmetic (`col1+col2`) is common enough that flagging it
 * creates noise. Those can be added later as a separate opt-in rule.
 */
export const binaryOperatorSpacingRule: TokenRule = {
	id: 'ninja.layout.binary-operator-spacing',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'Comparison operators (=, !=, <, <=, >, >=) should have a space on both sides.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const events = runSpacingEngine(
			model.ninjaSqlTokens,
			document,
			config,
			[BINARY_OPERATOR_SPEC],
			'ninja.layout.binary-operator-spacing',
		);

		return events
			.filter(e => e.kind === 'spacing')
			.map(e => ({
				rule: 'ninja.layout.binary-operator-spacing',
				message: e.message,
				range: e.range,
				...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
			}));
	},
};
