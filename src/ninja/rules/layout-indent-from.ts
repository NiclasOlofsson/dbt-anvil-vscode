import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * FROM should be at the same indent level as its SELECT (peer clause).
 * No check fires when SELECT is on the same line or the enclosing scope is a
 * subquery whose opening `(` is outside the backtrack window.
 */
const FROM_SPEC: IndentSpec = {
	triggerTypes: new Set(['FROM']),
	governorTypes: new Set(['SELECT']),
	diagnostic: 'ninja.layout.indent-from',
	shouldIndent: () => false,
};

export const indentFromRule: TokenRule = {
	id: 'ninja.layout.indent-from',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'FROM should be at the same indent level as its SELECT.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[FROM_SPEC],
			'ninja.layout.indent-from',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-from',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
