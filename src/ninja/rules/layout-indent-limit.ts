import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * Trailing clauses (LIMIT / OFFSET / QUALIFY / WINDOW) should be at the same
 * indent level as their preceding peer. The governor chain spans every
 * earlier clause since these can legitimately follow any of them.
 */
const LIMIT_SPEC: IndentSpec = {
	triggerTypes: new Set(['LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW']),
	// SELECT plus set-op keywords (for `LIMIT` at the outer level of a UNION).
	governorTypes: new Set([
		'SELECT', 'UNION', 'UNION_ALL', 'INTERSECT', 'EXCEPT',
	]),
	diagnostic: 'ninja.layout.indent-limit',
	shouldIndent: () => false,
};

export const indentLimitRule: TokenRule = {
	id: 'ninja.layout.indent-limit',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'LIMIT/OFFSET/QUALIFY/WINDOW should be at the same indent level as their preceding peer clause.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[LIMIT_SPEC],
			'ninja.layout.indent-limit',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-limit',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
