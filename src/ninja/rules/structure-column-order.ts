import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const columnOrderRule: TokenRule = {
	id: 'ninja.structure.column-order',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'hint',
	description: 'Wildcards (*) in SELECT should come before any named columns.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// Walk the token stream tracking paren depth.
		// When we encounter SELECT at depth 0 we enter "select scanning" mode and
		// look for top-level SELECT items until a clause keyword terminates the list.
		let depth = 0;

		// Clause keywords that end the SELECT target list.
		const CLAUSE_ENDS = new Set([
			'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'UNION',
			'INTERSECT', 'EXCEPT', 'FETCH', 'OFFSET', 'QUALIFY',
		]);

		for (let i = 0; i < tokens.length; i++) {
			const tok = tokens[i];

			if (tok.type === 'L_PAREN') { depth++; continue; }
			if (tok.type === 'R_PAREN') { depth--; continue; }
			if (depth !== 0) continue;

			if (tok.type !== 'SELECT') continue;

			// Enter SELECT scanning mode at depth 0.
			let seenNonStar = false;

			for (let j = i + 1; j < tokens.length; j++) {
				const t = tokens[j];

				if (t.type === 'L_PAREN') { depth++; continue; }
				if (t.type === 'R_PAREN') { depth--; continue; }

				// Only inspect top-level items (depth 0 relative to the SELECT).
				if (depth !== 0) continue;

				// End of SELECT list.
				if (CLAUSE_ENDS.has(t.type)) break;

				// COMMA separates items — no state change needed.
				if (t.type === 'COMMA') continue;

				// DISTINCT / ALL are modifiers on SELECT itself, not column items.
				if (t.type === 'DISTINCT' || t.type === 'ALL') continue;

				if (t.type === 'STAR') {
					// Check if this STAR is a qualified wildcard (e.g. table.*)
					// by looking at the preceding non-whitespace token.
					const prev = j > i + 1 ? tokens[j - 1] : null;
					if (prev && prev.type === 'DOT') {
						// Qualified wildcard (table.*) — treat as non-star for ordering purposes.
						seenNonStar = true;
						continue;
					}

					// Unqualified STAR after a named column → violation.
					if (seenNonStar) {
						violations.push({
							rule: 'ninja.structure.column-order',
							message: 'Wildcard (*) should appear before named columns in SELECT.',
							range: tokenRange(text, t),
						});
					}
					// Do not set seenNonStar here — a STAR is a wildcard, not a named column.
					continue;
				}

				// Any other token is a named-column expression.
				seenNonStar = true;
			}

			// Reset depth after inner scan (it should be 0 already at end of SELECT list,
			// but guard in case of malformed SQL).
			depth = 0;
		}

		return violations;
	},
};
