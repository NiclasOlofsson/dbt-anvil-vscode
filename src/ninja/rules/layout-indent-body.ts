import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runBodyIndentEngine } from '../layout/indent-body-engine';

/**
 * Clause-body tokens (columns in SELECT, tables in FROM, conditions in WHERE,
 * keys in GROUP BY / HAVING / ORDER BY / LIMIT) should be indented one level
 * deeper than their governing clause keyword.
 *
 * Only fires for tokens that are the first content token on their line. Tokens
 * owned by other indent rules (JOIN, ON, THEN, UNION, clause keywords
 * themselves, operator continuations) are excluded via the engine's skip set.
 *
 * This does not handle subquery or CTE-body indentation — those need a rule
 * that anchors to the enclosing `(` line.
 */
export const indentBodyRule: TokenRule = {
	id: 'ninja.layout.indent-body',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'Clause-body content (columns, tables, conditions) should be indented one level under its clause keyword.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const events = runBodyIndentEngine(
			ctx.model.ninjaSqlTokens,
			ctx.document,
			ctx.config,
		);
		return events.map(e => ({
			rule: 'ninja.layout.indent-body',
			message: e.message,
			range: e.range,
			action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix },
		}));
	},
};
