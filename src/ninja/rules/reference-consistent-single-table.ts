import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * RF03 — In single-table queries (FROM without any JOINs), column references
 * should NOT be qualified with the table name — the qualifier is redundant and
 * adds noise without providing clarity.
 *
 * Detection:
 * 1. Count JOIN keywords at paren depth 0. If any exist, skip (qualification is needed).
 * 2. Find DOT tokens at depth 0 — a DOT between two VAR tokens indicates `table.column`.
 * 3. Flag the DOT token (and the table qualifier before it) with a hint.
 */
export const consistentSingleTableRule: TokenRule = {
	id: 'ninja.reference.consistent-single-table',
	type: 'token',
	category: NinjaCategory.Reference,
	defaultSeverity: 'hint',
	description: 'In a single-table query, column qualification is redundant.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		// Count JOIN keywords at depth 0
		let depth = 0;
		let joinCount = 0;
		for (const tok of tokens) {
			if (tok.type === 'L_PAREN') { depth++; continue; }
			if (tok.type === 'R_PAREN') { depth = Math.max(0, depth - 1); continue; }
			if (depth === 0 && tok.type === 'JOIN') joinCount++;
		}

		// If there are JOINs, qualification is appropriate — skip.
		if (joinCount > 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		depth = 0;
		for (let i = 1; i < tokens.length - 1; i++) {
			const tok = tokens[i];
			if (tok.type === 'L_PAREN') { depth++; continue; }
			if (tok.type === 'R_PAREN') { depth = Math.max(0, depth - 1); continue; }

			// We only care about DOT tokens at depth 0
			if (depth !== 0) continue;
			if (tok.type !== 'DOT') continue;

			const prev = tokens[i - 1];
			const next = tokens[i + 1];

			// Both sides must be VAR tokens to confirm this is a table.column reference
			if (!prev || prev.type !== 'VAR') continue;
			if (!next || next.type !== 'VAR') continue;

			// Flag the DOT token's range
			const range = tokenRange(text, tok);
			violations.push({
				rule: 'ninja.reference.consistent-single-table',
				message: 'In a single-table query, column qualification is redundant.',
				range,
			});
		}

		return violations;
	},
};
