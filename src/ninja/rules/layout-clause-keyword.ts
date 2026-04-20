import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { runSpacingEngine } from '../layout/spacing-engine';
import { CLAUSE_KEYWORD_SPEC } from '../layout/spacing-specs';

/**
 * SQL clause-opening keywords must be the first non-space content on their line.
 *
 * This covers WHERE, GROUP BY, HAVING, ORDER BY, LIMIT, and QUALIFY.
 * SELECT and FROM are intentionally excluded — they commonly appear on one
 * line with content in short queries (e.g. `select 1 from dual`) and the
 * reflow engine handles their full layout.
 *
 * Correct (dbt style):
 *   select id, name
 *   from orders
 *   where status = 'active'
 *   group by 1
 *   order by created_at desc
 *
 * Violation:
 *   select id, name from orders where status = 'active'
 */
export const clauseKeywordRule: TokenRule = {
	id: 'ninja.layout.clause-keyword',
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'SQL clause keywords (WHERE, GROUP BY, HAVING, ORDER BY, LIMIT) must be at the start of their own line.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const events = runSpacingEngine(
			model.ninjaSqlTokens,
			document,
			config,
			[CLAUSE_KEYWORD_SPEC],
			'ninja.layout.clause-keyword',
		);

		return events
			.filter(e => e.kind === 'line-position')
			.map(e => ({
				rule: 'ninja.layout.clause-keyword',
				message: e.message,
				range: e.range,
				...(e.fix ? { action: { type: 'fix' as const, ops: e.fix.ops, autoFix: e.fix.autoFix } } : {}),
			}));
	},
};
