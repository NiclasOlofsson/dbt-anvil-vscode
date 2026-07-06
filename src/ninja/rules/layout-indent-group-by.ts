import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * GROUP BY should be at the same indent level as its preceding peer
 * (WHERE / FROM / SELECT).
 *
 * Triggers on both the combined token `GROUP_BY` and the split form
 * `GROUP` (which precedes a separate `BY` token in some dialects). Same for
 * the anchor check.
 */
const GROUP_BY_SPEC: IndentSpec = {
	triggerTypes: new Set(['GROUP_BY', 'GROUP']),
	// Use SELECT as the stable anchor — cascading through WHERE/FROM would
	// oscillate when any of them is misaligned.
	governorTypes: new Set(['SELECT']),
	diagnostic: 'ninja.layout.indent-group-by',
	shouldIndent: () => false,
};

export const indentGroupByRule: TokenRule = {
	id: 'ninja.layout.indent-group-by',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'GROUP BY should be at the same indent level as its preceding peer clause.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[GROUP_BY_SPEC],
			'ninja.layout.indent-group-by',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-group-by',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
