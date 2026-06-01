import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * Set operators (UNION / UNION ALL / INTERSECT / EXCEPT) should be at the
 * same indent level as the SELECT they follow. The governor chain includes
 * other set operators so chained UNIONs stay aligned with each other and
 * with their selects.
 */
const SET_OP_TYPES = ['UNION', 'UNION_ALL', 'INTERSECT', 'EXCEPT'];

const SET_OP_SPEC: IndentSpec = {
	triggerTypes: new Set(SET_OP_TYPES),
	governorTypes: new Set(['SELECT', ...SET_OP_TYPES]),
	diagnostic: 'ninja.layout.indent-set-op',
	shouldIndent: () => false,
};

export const indentSetOpRule: TokenRule = {
	id: 'ninja.layout.indent-set-op',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'UNION / INTERSECT / EXCEPT should be at the same indent level as the SELECT they follow.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[SET_OP_SPEC],
			'ninja.layout.indent-set-op',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-set-op',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
