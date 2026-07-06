import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import { tokenRange } from '../token-utils';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE_ID = 'ninja.layout.select-targets';

/** Clause keywords that end the SELECT target list at depth 0. */
const CLAUSE_KEYWORDS = new Set([
	'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'QUALIFY',
]);

export const selectTargetsRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'Each target in a multi-column SELECT should be on its own line (LT09)',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		// The rule mirrors the formatter's `alwaysWrap.select` toggle —
		// without the toggle on, short multi-target SELECTs are allowed
		// inline and there is nothing to flag. Gating here keeps the rule
		// and the reflow engine in lockstep so "format then lint" stays
		// clean under either policy.
		if (!ctx.config.layout.alwaysWrap.select) return [];

		const sqlTokens = sqlOnly(ctx.model.ninjaSqlTokens);
		if (sqlTokens.length === 0) return [];

		const violations: NinjaViolation[] = [];
		const text = ctx.document.getText();

		for (let i = 0; i < sqlTokens.length; i++) {
			const tok = sqlTokens[i];
			if (tok.type.toUpperCase() !== 'SELECT') continue;

			// Collect the target list: tokens between SELECT and the next top-level
			// clause keyword (or end of tokens). Track paren depth so we only
			// inspect top-level positions.
			const selectLine = tok.line;
			let depth = 0;
			let topLevelCommas = 0;
			let lastLine = selectLine; // the furthest line covered by any target token

			let j = i + 1;
			for (; j < sqlTokens.length; j++) {
				const t = sqlTokens[j];
				const ttype = t.type.toUpperCase();

				if (ttype === 'L_PAREN') {
					depth++;
					continue;
				}
				if (ttype === 'R_PAREN') {
					if (depth > 0) depth--;
					continue;
				}

				// At depth 0, a clause keyword ends the target list.
				if (depth === 0 && CLAUSE_KEYWORDS.has(ttype)) break;

				// At depth 0, count commas as target separators.
				if (depth === 0 && ttype === 'COMMA') {
					topLevelCommas++;
					continue;
				}

				// Track the maximum line used by any target token at any depth.
				if (t.line > lastLine) lastLine = t.line;
			}

			// Only flag when there are multiple targets (≥1 top-level comma) AND
			// all of them are on the same line as SELECT.
			if (topLevelCommas >= 1 && lastLine === selectLine) {
				const range = tokenRange(text, tok as SqlToken);
				violations.push({
					rule: RULE_ID,
					message: 'Each SELECT target should be on its own line when there are multiple targets',
					range,
				});
			}
		}

		return violations;
	},
};
