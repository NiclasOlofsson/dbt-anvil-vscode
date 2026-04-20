import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import type { SqlToken } from '../../ftl/parse-result';

const CLAUSE_KEYWORDS = new Set([
	'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'QUALIFY', 'WINDOW',
]);
const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);

/**
 * Count top-level commas (depth 0) in a SELECT body — i.e. the number of
 * column separators between the SELECT keyword and the next top-level clause
 * keyword or set operator. Returns null when SELECT * is used (indeterminate).
 */
function countSelectColumns(tokens: SqlToken[], selectIdx: number): number | null {
	let commas = 0;
	let depth = 0;
	for (let i = selectIdx + 1; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.type === 'L_PAREN') { depth++; continue; }
		if (t.type === 'R_PAREN') { depth--; continue; }
		if (depth > 0) continue;
		if (CLAUSE_KEYWORDS.has(t.type) || SET_OPERATORS.has(t.type)) break;
		if (t.type === 'STAR') return null; // SELECT * — column count indeterminate
		if (t.type === 'COMMA') commas++;
	}
	return commas + 1;
}

export const setopColumnCountRule: TokenRule = {
	id: 'ninja.ambiguity.setop-column-count',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'error',
	description: 'All SELECT statements in a UNION/INTERSECT/EXCEPT must have the same number of columns.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		// Collect top-level SELECT indices and set-operator indices.
		let depth = 0;
		const selectIdxs: number[] = [];
		const setOpIdxs: number[] = [];
		for (let i = 0; i < tokens.length; i++) {
			const t = tokens[i];
			if (t.type === 'L_PAREN') { depth++; continue; }
			if (t.type === 'R_PAREN') { depth--; continue; }
			if (depth !== 0) continue;
			if (t.type === 'SELECT') selectIdxs.push(i);
			else if (SET_OPERATORS.has(t.type)) setOpIdxs.push(i);
		}

		// No set operators → rule doesn't apply.
		if (setOpIdxs.length === 0) return [];

		// Count columns for each top-level SELECT.
		const counts = selectIdxs.map(idx => countSelectColumns(tokens, idx));
		const definite = counts.filter((c): c is number => c !== null);
		if (definite.length < 2) return [];

		// Find the expected count (first SELECT with a concrete count).
		const expected = definite[0];
		const violations: NinjaViolation[] = [];
		const text = document.getText();

		for (let i = 0; i < counts.length; i++) {
			const count = counts[i];
			if (count === null || count === expected) continue;
			// Flag the SELECT token of the mismatched member.
			const tok = tokens[selectIdxs[i]];
			violations.push({
				rule: 'ninja.ambiguity.setop-column-count',
				message: `Column count mismatch in set operation: expected ${expected} column${expected === 1 ? '' : 's'}, got ${count}.`,
				range: tokenRange(text, tok),
			});
		}

		return violations;
	},
};
