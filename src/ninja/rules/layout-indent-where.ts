import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * WHERE should be at the same indent level as its FROM (or SELECT) peer.
 * Governor backtracks through FROM first, then SELECT, stopping at the
 * current bracket scope boundary.
 */
const WHERE_SPEC: IndentSpec = {
	triggerTypes: new Set(['WHERE']),
	// Use SELECT as the stable anchor so this rule is convergent even when
	// FROM is misaligned (FROM's own rule fixes FROM independently).
	governorTypes: new Set(['SELECT']),
	diagnostic: 'ninja.layout.indent-where',
	shouldIndent: () => false,
};

export const indentWhereRule: TokenRule = {
	id: 'ninja.layout.indent-where',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'WHERE should be at the same indent level as its FROM/SELECT peer.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[WHERE_SPEC],
			'ninja.layout.indent-where',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-where',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
