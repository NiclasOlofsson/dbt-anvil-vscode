import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * Keywords that precede JOIN and qualify its type.
 * We need to know whether the join was a CROSS JOIN so we can skip the ON/USING check.
 */
const JOIN_QUALIFIERS = new Set(['INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS']);

/**
 * Clause-level keywords that end a JOIN body at depth 0.
 * When we see one of these we know the JOIN body ended.
 */
const JOIN_BODY_TERMINATORS = new Set([
	'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
	'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT',
	'QUALIFY', 'UNION', 'INTERSECT', 'EXCEPT',
	'SEMICOLON',
]);

export const joinWithoutOnRule: TokenRule = {
	id: 'ninja.ambiguity.join-without-on',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'warning',
	description: 'JOIN missing ON or USING condition — this may produce a cartesian product.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'JOIN') continue;

			const joinTok = tokens[i];

			// Check if this is a CROSS JOIN by looking at the immediately preceding qualifier
			const prev = tokens[i - 1];
			const isCrossJoin = prev?.type === 'CROSS';

			if (isCrossJoin) continue;

			// Scan forward in the JOIN body for ON or USING at depth 0
			let depth = 0;
			let hasCondition = false;

			for (let j = i + 1; j < tokens.length; j++) {
				const tok = tokens[j];

				if (tok.type === 'L_PAREN' || tok.type === 'LPAREN') { depth++; continue; }
				if (tok.type === 'R_PAREN' || tok.type === 'RPAREN') { depth--; continue; }

				if (depth === 0) {
					if (JOIN_BODY_TERMINATORS.has(tok.type)) break;
					if (tok.type === 'ON' || tok.type === 'USING') {
						hasCondition = true;
						break;
					}
				}
			}

			if (!hasCondition) {
				violations.push({
					rule: 'ninja.ambiguity.join-without-on',
					message: 'JOIN missing ON or USING condition.',
					range: tokenRange(text, joinTok),
				});
			}
		}

		return violations;
	},
};
