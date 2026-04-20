import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

/**
 * ST09 — Join Table Order
 *
 * Ideally this rule checks that, in a JOIN ... ON condition, the "driving"
 * table (the FROM-side table) appears on the left side of equality predicates.
 * For example:
 *   FROM orders o JOIN customers c ON c.id = o.customer_id  ← driving col on right (violation)
 *   FROM orders o JOIN customers c ON o.customer_id = c.id  ← correct
 *
 * Reliably enforcing this requires knowing which aliases belong to the FROM
 * table vs the JOIN table, and which identifiers in each ON expression are
 * column references vs literals.  That level of semantic resolution is not
 * available from the raw SQL token stream alone — it needs either the
 * DocumentModel's resolved TableRefTokens/ColumnRefTokens (which may be
 * absent on first parse) or a full AST walk.
 *
 * This stub always returns no violations.  A future implementation can
 * replace the check body once the semantic information is reliable enough.
 */
export const joinTableOrderRule: TokenRule = {
	id: 'ninja.structure.join-table-order',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'hint',
	description: 'In JOIN ON conditions, the driving (FROM) table\'s column should appear on the left side of equality predicates.',

	// eslint-disable-next-line @typescript-eslint/no-unused-vars
	check(_ctx: TokenRuleContext): NinjaViolation[] {
		// Not yet implemented — requires resolved column/table metadata.
		return [];
	},
};
