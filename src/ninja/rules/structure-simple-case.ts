import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

function lineOffset(text: string, charOffset: number): { line: number; col: number } {
	let line = 0;
	let lastNewline = -1;
	for (let i = 0; i < charOffset && i < text.length; i++) {
		if (text[i] === '\n') { line++; lastNewline = i; }
	}
	return { line, col: charOffset - lastNewline - 1 };
}

const BOOL_TRUE = new Set(['true', '1']);
const BOOL_FALSE = new Set(['false', '0']);

export const simpleCaseRule: TokenRule = {
	id: 'ninja.structure.simple-case',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'info',
	description: 'CASE WHEN x THEN TRUE ELSE FALSE END can be simplified to just x.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens) return [];
		const text = document.getText();
		const violations: NinjaViolation[] = [];

		const tokens = model.sqlTokens;

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

			const thenWord = text.slice(tokens[thenValIdx].start, tokens[thenValIdx].end + 1).toLowerCase();
			const elseWord = text.slice(tokens[elseValIdx].start, tokens[elseValIdx].end + 1).toLowerCase();

			const isTrueFalse = BOOL_TRUE.has(thenWord) && BOOL_FALSE.has(elseWord);
			const isFalseTrue = BOOL_FALSE.has(thenWord) && BOOL_TRUE.has(elseWord);

			if (!isTrueFalse && !isFalseTrue) continue;

			const caseStart = lineOffset(text, tokens[i].start);
			const endEnd = lineOffset(text, tokens[endIdx].end + 1);

			violations.push({
				rule: 'ninja.structure.simple-case',
				message: 'Simplify boolean CASE expression — replace with the condition directly.',
				range: new vscode.Range(caseStart.line, caseStart.col, endEnd.line, endEnd.col),
			});
		}

		return violations;
	},
};
