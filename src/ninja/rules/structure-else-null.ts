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

export const elseNullRule: TokenRule = {
	id: 'ninja.structure.else-null',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'info',
	description: 'Redundant ELSE NULL — CASE already returns NULL by default.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens) return [];
		const text = document.getText();
		const violations: NinjaViolation[] = [];

		const tokens = model.sqlTokens;

		for (let i = 0; i < tokens.length - 2; i++) {
			if (tokens[i].type !== 'ELSE') continue;
			if (tokens[i + 1].type !== 'NULL') continue;
			if (tokens[i + 2].type !== 'END') continue;

			const elseStart = lineOffset(text, tokens[i].start);
			const nullEnd = lineOffset(text, tokens[i + 1].end + 1);
			const endStart = lineOffset(text, tokens[i + 2].start);

			// Fix removes from ELSE start to just before END
			violations.push({
				rule: 'ninja.structure.else-null',
				message: 'Redundant ELSE NULL — CASE returns NULL by default.',
				range: new vscode.Range(elseStart.line, elseStart.col, nullEnd.line, nullEnd.col),
				fix: [{
					range: new vscode.Range(elseStart.line, elseStart.col, endStart.line, endStart.col),
					newText: '',
				}],
			});
		}

		return violations;
	},
};
