import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const subqueryToCteRule: TokenRule = {
	id: 'ninja.structure.subquery-to-cte',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'hint',
	description: 'Subqueries in FROM/JOIN clauses should be converted to CTEs for readability.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// Track paren depth so we can identify FROM/JOIN tokens at depth 0.
		// Depth 0 is the top-level query. Subqueries inside parens are at depth ≥ 1.
		let depth = 0;

		// We flag when the *next significant token* after FROM / JOIN is L_PAREN.
		// This covers:
		//   SELECT ... FROM (SELECT ...) AS sub
		//   SELECT ... LEFT JOIN (SELECT ...) AS sub ON ...
		// "Significant" here means we skip whitespace only; all non-paren tokens
		// between FROM/JOIN and L_PAREN abort the match.
		let awaitingParen = false;

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];

			if (tok.type === 'L_PAREN') {
				if (awaitingParen && depth === 0) {
					// Subquery in FROM/JOIN at top level — flag the opening paren.
					violations.push({
						rule: 'ninja.structure.subquery-to-cte',
						message: 'Consider converting this subquery to a CTE for readability.',
						range: tokenRange(text, tok),
					});
				}
				awaitingParen = false;
				depth++;
				continue;
			}

			if (tok.type === 'R_PAREN') {
				depth--;
				awaitingParen = false;
				continue;
			}

			if (depth !== 0) {
				// Inside parens — reset the trigger flag (FROM/JOIN inside a subquery
				// are handled at their own depth when we recurse into that paren).
				awaitingParen = false;
				continue;
			}

			// At depth 0: check for FROM or any JOIN keyword.
			if (tok.type === 'FROM' || tok.type === 'JOIN') {
				awaitingParen = true;
				continue;
			}

			// Any other significant token at depth 0 cancels waiting for a paren.
			awaitingParen = false;
		}

		return violations;
	},
};
