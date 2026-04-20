import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runBracketIndentEngine } from '../layout/indent-bracket-engine';

/**
 * Content inside `(...)` — subquery bodies, CTE bodies, multi-line function
 * call args, multi-line `IN` lists — should be indented one level deeper
 * than the opening bracket's line.
 *
 * Hands off to `indent-body` as soon as a clause keyword appears inside the
 * scope: once we see SELECT, `indent-body` owns everything after it.
 */
export const indentBracketRule: TokenRule = {
	id: 'ninja.layout.indent-bracket',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'Content inside `(...)` should be indented one level under the opening bracket.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runBracketIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-bracket',
			message: e.message,
			range: e.range,
			action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix },
		}));
	},
};
