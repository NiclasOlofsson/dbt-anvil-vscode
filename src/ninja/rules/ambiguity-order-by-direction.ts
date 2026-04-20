import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import type { SqlToken } from '../../ftl/parse-result';

/** Clause-level keywords that end an ORDER BY list at depth 0. */
const ORDER_BY_TERMINATORS = new Set([
	'LIMIT', 'HAVING', 'QUALIFY', 'WINDOW',
	'UNION', 'INTERSECT', 'EXCEPT',
	'SEMICOLON',
]);

export const orderByDirectionRule: TokenRule = {
	id: 'ninja.ambiguity.order-by-direction',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'hint',
	description: 'Every ORDER BY item should have an explicit ASC or DESC direction.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'ORDER') continue;

			// Find the BY immediately after ORDER
			const next = tokens[i + 1];
			if (!next || next.type !== 'BY') continue;
			const byIdx = i + 1;

			// Collect the ORDER BY items, splitting on top-level commas,
			// stopping at terminators or end of stream.
			const items: SqlToken[][] = [];
			let currentItem: SqlToken[] = [];
			let depth = 0;
			let terminated = false;

			for (let j = byIdx + 1; j < tokens.length; j++) {
				const tok = tokens[j];

				if (tok.type === 'L_PAREN' || tok.type === 'LPAREN') {
					depth++;
					currentItem.push(tok);
					continue;
				}
				if (tok.type === 'R_PAREN' || tok.type === 'RPAREN') {
					depth--;
					currentItem.push(tok);
					continue;
				}

				if (depth === 0) {
					if (ORDER_BY_TERMINATORS.has(tok.type)) {
						terminated = true;
						i = j - 1; // resume outer loop at the terminator
						break;
					}
					if (tok.type === 'COMMA') {
						items.push(currentItem);
						currentItem = [];
						continue;
					}
				}

				currentItem.push(tok);
			}

			// Push the last item (whether terminated or end-of-stream)
			items.push(currentItem);
			if (!terminated) i = tokens.length - 1;

			// Check each item for an explicit direction keyword
			for (const item of items) {
				if (item.length === 0) continue;
				const hasDirection = item.some(t => t.type === 'ASC' || t.type === 'DESC' || t.type === 'NULLS');
				if (!hasDirection) {
					const lastTok = item[item.length - 1];
					violations.push({
						rule: 'ninja.ambiguity.order-by-direction',
						message: 'ORDER BY item missing explicit ASC/DESC.',
						range: tokenRange(text, lastTok),
					});
				}
			}
		}

		return violations;
	},
};
