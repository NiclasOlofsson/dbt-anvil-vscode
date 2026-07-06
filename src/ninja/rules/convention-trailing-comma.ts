import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { deleteOp } from '../fix-op';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * CV03 — Trailing comma on the last SELECT column.
 *
 * When `commaPosition === 'leading'`, no trailing comma should exist on
 * the last item. The rule flags any trailing comma it finds.
 *
 * When `commaPosition === 'trailing'`, the rule is a no-op — neither
 * sqlfmt's style guide nor the current dbt-labs style guide require a
 * trailing comma after the final SELECT target, and the printer no longer
 * injects one. (Some dialects — Snowflake, BigQuery, DuckDB — permit it
 * syntactically, but no popular style guide makes it the default.)
 *
 * "Last item" is defined as the last COMMA found before the next top-level
 * clause keyword (FROM / WHERE / GROUP / HAVING / ORDER / LIMIT / QUALIFY /
 * WINDOW) or the end of the token stream. If there are only whitespace/comment
 * tokens between that last COMMA and the next clause keyword, the trailing
 * comma exists; if there are value tokens in between, it does not.
 *
 * The rule is skipped for single-line SELECT lists.
 */
export const trailingCommaRule: TokenRule = {
	id: 'ninja.convention.trailing-comma',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'hint',
	description: 'Enforce trailing comma after the last SELECT column (dbt-labs style).',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [
		{ settingPath: 'layout.commaPosition', label: 'Comma position', type: 'enum', choices: ['trailing', 'leading'] },
	],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// Clause keywords that end a SELECT list at the top level.
		const CLAUSE_TYPES = new Set([
			'FROM', 'WHERE', 'GROUP_BY', 'HAVING', 'ORDER_BY', 'LIMIT', 'QUALIFY',
			'WINDOW', 'UNION', 'UNION_ALL', 'INTERSECT', 'EXCEPT',
			// Some dialects emit plain keyword tokens in addition to compounds
			'GROUP', 'ORDER',
		]);

		// Walk token stream; find every SELECT keyword.
		for (let si = 0; si < tokens.length; si++) {
			if (tokens[si].type !== 'SELECT') continue;

			const selectLine = tokens[si].line;

			// Gather the SELECT-clause window: tokens from SELECT up to (but not
			// including) the next top-level CLAUSE_TYPES keyword, the close paren
			// that ends the enclosing query (CTE body / subquery), or end of stream.
			// Tracking paren depth from the SELECT prevents the walk from crossing
			// into the next CTE's body, where its own SELECT-list commas would
			// otherwise be misread as belonging to this SELECT.
			let endIdx = tokens.length;
			let depth = 0;
			for (let k = si + 1; k < tokens.length; k++) {
				const t = tokens[k].type;
				if (t === 'L_PAREN') { depth++; continue; }
				if (t === 'R_PAREN') {
					if (depth === 0) { endIdx = k; break; }
					depth--;
					continue;
				}
				if (depth === 0 && CLAUSE_TYPES.has(t)) { endIdx = k; break; }
			}

			// Skip single-line SELECT lists.
			const lastTokInClause = tokens[endIdx - 1];
			if (lastTokInClause.line === selectLine) continue;

			// Collect COMMA tokens within this clause window.
			const commas: number[] = []; // indices into tokens[]
			for (let k = si + 1; k < endIdx; k++) {
				if (tokens[k].type === 'COMMA') commas.push(k);
			}

			// No commas → single column, nothing to check.
			if (commas.length === 0) continue;

			const lastCommaIdx = commas[commas.length - 1];
			const lastComma = tokens[lastCommaIdx];

			// Check whether there are any non-whitespace SQL tokens after the last
			// comma and before the clause boundary.
			let hasValueAfterLastComma = false;
			for (let k = lastCommaIdx + 1; k < endIdx; k++) {
				// Skip whitespace-only spans — the token stream doesn't include WS tokens, so
				// any token here is a real value token.
				hasValueAfterLastComma = true;
				break;
			}

			// Trailing-comma mode no longer enforces a trailing comma on the
			// last target — see the rule's docblock. Only the leading-comma
			// mode has anything to flag here.
			if (config.layout.commaPosition === 'trailing') continue;

			// Leading mode: no trailing comma on the last item. Flag when the
			// last comma IS NOT followed by any value token (i.e. it IS a
			// trailing comma).
			if (hasValueAfterLastComma) {
				// Last comma has value tokens after it — not a trailing comma.
				continue;
			}
			// The last comma is a trailing comma — flag it.
			const lo = lineOffset(text, lastComma.line);
			const range = new vscode.Range(
				lastComma.line, lastComma.start - lo,
				lastComma.line, lastComma.end + 1 - lo,
			);
			violations.push({
				rule: 'ninja.convention.trailing-comma',
				message: 'Trailing comma after last SELECT column is not allowed (leading comma style).',
				range,
				action: {
					type: FixAction.TYPE,
					ops: [deleteOp(range)],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};
