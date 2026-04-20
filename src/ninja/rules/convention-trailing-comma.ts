import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { replaceOp, deleteOp } from '../fix-op';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * CV03 — Trailing comma on the last SELECT column.
 *
 * When `commaPosition === 'trailing'`, the last column in a multi-line SELECT
 * list MUST have a trailing comma (dbt-labs style). When `commaPosition ===
 * 'leading'`, no trailing comma should exist on the last item.
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
			// sqlglot emits plain keyword tokens too
			'GROUP', 'ORDER',
		]);

		// Walk token stream; find every SELECT keyword.
		for (let si = 0; si < tokens.length; si++) {
			if (tokens[si].type !== 'SELECT') continue;

			const selectLine = tokens[si].line;

			// Gather the SELECT-clause window: tokens from SELECT up to (but not
			// including) the next top-level CLAUSE_TYPES keyword or end of stream.
			let endIdx = tokens.length;
			for (let k = si + 1; k < tokens.length; k++) {
				if (CLAUSE_TYPES.has(tokens[k].type)) { endIdx = k; break; }
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
				// Skip whitespace-only spans — sqlglot does not emit WS tokens, so
				// any token here is a real value token.
				hasValueAfterLastComma = true;
				break;
			}

			const commaPosition = config.layout.commaPosition;

			if (commaPosition === 'trailing') {
				// Trailing mode: the last comma MUST be followed by value tokens
				// (i.e. there is no trailing comma on the last item). Flag when the
				// last comma is NOT followed by any value token.
				if (!hasValueAfterLastComma) {
					// Last comma IS a trailing comma — that's correct in trailing mode.
					// No violation.
					continue;
				}
				// The last column item has no trailing comma. We need to insert one
				// after the last value token before the clause boundary.
				// Use the trimmed end of the token's line to avoid placing the comma
				// after any trailing whitespace.
				const insertAfter = tokens[endIdx - 1];
				const lineText = document.lineAt(insertAfter.line).text;
				const insertCol = lineText.trimEnd().length;
				const insertPos = new vscode.Position(insertAfter.line, insertCol);
				const insertRange = new vscode.Range(insertPos, insertPos);
				violations.push({
					rule: 'ninja.convention.trailing-comma',
					message: 'Last SELECT column should have a trailing comma.',
					range: insertRange,
					action: {
						type: FixAction.TYPE,
						ops: [replaceOp(insertRange, ',')],
						autoFix: true,
					},
				});
			} else {
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
		}

		return violations;
	},
};
