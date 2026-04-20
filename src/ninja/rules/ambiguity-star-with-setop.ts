import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);

export const starWithSetOpRule: TokenRule = {
	id: 'ninja.ambiguity.star-with-setop',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'warning',
	description: 'SELECT * is ambiguous when combined with set operations (UNION/INTERSECT/EXCEPT) — use an explicit column list.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();

		// Check for top-level set operators (not inside parens)
		let hasSetOp = false;
		let depth = 0;
		for (const tok of tokens) {
			if (tok.type === 'L_PAREN' || tok.type === 'LPAREN') { depth++; continue; }
			if (tok.type === 'R_PAREN' || tok.type === 'RPAREN') { depth--; continue; }
			if (depth === 0 && SET_OPERATORS.has(tok.type)) { hasSetOp = true; break; }
		}

		if (!hasSetOp) return [];

		// Flag every SELECT immediately followed by STAR
		const violations: NinjaViolation[] = [];
		for (let i = 0; i < tokens.length - 1; i++) {
			if (tokens[i].type === 'SELECT' && tokens[i + 1].type === 'STAR') {
				violations.push({
					rule: 'ninja.ambiguity.star-with-setop',
					message: 'SELECT * is ambiguous with set operations — use explicit column list.',
					range: tokenRange(text, tokens[i + 1]),
				});
			}
		}

		return violations;
	},
};
