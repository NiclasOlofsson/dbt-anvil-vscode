import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runIndentEngine, type IndentSpec } from '../layout/indent-engine';

/**
 * HAVING should be at the same indent level as its preceding peer clause
 * (GROUP BY / WHERE / FROM / SELECT).
 */
const HAVING_SPEC: IndentSpec = {
	triggerTypes: new Set(['HAVING']),
	// Use SELECT as the stable anchor.
	governorTypes: new Set(['SELECT']),
	diagnostic: 'ninja.layout.indent-having',
	shouldIndent: () => false,
};

export const indentHavingRule: TokenRule = {
	id: 'ninja.layout.indent-having',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'HAVING should be at the same indent level as its preceding peer clause.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
			[HAVING_SPEC],
			'ninja.layout.indent-having',
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-having',
			message: e.message,
			range: e.range,
			...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
		}));
	},
};
