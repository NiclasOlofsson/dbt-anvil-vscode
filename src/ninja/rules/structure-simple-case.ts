import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { offsetToLineCol } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const BOOL_TRUE = new Set(['true', '1']);
const BOOL_FALSE = new Set(['false', '0']);
// Token types for boolean / numeric literals — checked alongside text so a
// VAR identifier whose text happens to be "true"/"1" isn't mistaken for the literal value.
const LITERAL_TYPES = new Set(['TRUE', 'FALSE', 'NUMBER']);

export const simpleCaseRule: TokenRule = {
	id: 'ninja.structure.simple-case',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'info',
	description: 'CASE WHEN x THEN TRUE ELSE FALSE END can be simplified to just x.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];
		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// Look for pattern: CASE WHEN ... THEN (TRUE|1) ELSE (FALSE|0) END
		// or the inverse:    CASE WHEN ... THEN (FALSE|0) ELSE (TRUE|1) END
		for (let i = 0; i < tokens.length - 6; i++) {
			if (tokens[i].type !== 'CASE') continue;
			if (tokens[i + 1].type !== 'WHEN') continue;

			// Find the matching THEN
			let thenIdx = -1;
			let depth = 0;
			for (let j = i + 2; j < tokens.length; j++) {
				if (tokens[j].type === 'CASE') depth++;
				if (tokens[j].type === 'END') {
					if (depth === 0) break;
					depth--;
				}
				if (depth === 0 && tokens[j].type === 'THEN') {
					thenIdx = j;
					break;
				}
			}
			if (thenIdx === -1) continue;

			// Must have THEN <value> ELSE <value> END
			const thenValIdx = thenIdx + 1;
			const elseIdx = thenIdx + 2;
			const elseValIdx = thenIdx + 3;
			const endIdx = thenIdx + 4;

			if (endIdx >= tokens.length) continue;
			if (tokens[elseIdx].type !== 'ELSE') continue;
			if (tokens[endIdx].type !== 'END') continue;

			// Both THEN/ELSE values must be literal-typed tokens — guards against VAR identifiers
			// whose text happens to spell "true"/"false"/"1"/"0".
			if (!LITERAL_TYPES.has(tokens[thenValIdx].type)) continue;
			if (!LITERAL_TYPES.has(tokens[elseValIdx].type)) continue;

			const thenWord = text.slice(tokens[thenValIdx].start, tokens[thenValIdx].end + 1).toLowerCase();
			const elseWord = text.slice(tokens[elseValIdx].start, tokens[elseValIdx].end + 1).toLowerCase();

			const isTrueFalse = BOOL_TRUE.has(thenWord) && BOOL_FALSE.has(elseWord);
			const isFalseTrue = BOOL_FALSE.has(thenWord) && BOOL_TRUE.has(elseWord);

			if (!isTrueFalse && !isFalseTrue) continue;

			const caseStart = offsetToLineCol(text, tokens[i].start);
			const endEnd = offsetToLineCol(text, tokens[endIdx].end + 1);

			violations.push({
				rule: 'ninja.structure.simple-case',
				message: 'Simplify boolean CASE expression — replace with the condition directly.',
				range: new vscode.Range(caseStart.line, caseStart.col, endEnd.line, endEnd.col),
			});
		}

		return violations;
	},
};
