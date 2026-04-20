import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * ORDER BY should be at the same indent level as its preceding peer clause.
 * Triggers on both combined `ORDER_BY` and split `ORDER` forms.
 */
const ORDER_BY_SPEC: IndentSpec = {
	triggerTypes: new Set(['ORDER_BY', 'ORDER']),
	// SELECT plus set-op keywords (for `ORDER BY` at the outer level of a UNION).
	governorTypes: new Set([
		'SELECT', 'UNION', 'UNION_ALL', 'INTERSECT', 'EXCEPT',
	]),
	diagnostic: 'ninja.layout.indent-order-by',
	shouldIndent: () => false,
};

export const indentOrderByRule: TokenRule = {
	id: 'ninja.layout.indent-order-by',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'ORDER BY should be at the same indent level as its preceding peer clause.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[ORDER_BY_SPEC],
			'ninja.layout.indent-order-by',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-order-by',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
