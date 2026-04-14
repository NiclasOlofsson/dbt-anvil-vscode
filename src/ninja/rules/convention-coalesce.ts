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

const LEGACY = new Set(['ifnull', 'nvl', 'isnull']);

export const coalesceRule: TokenRule = {
	id: 'ninja.convention.coalesce',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Use COALESCE instead of legacy null-handling functions (IFNULL, NVL, ISNULL).',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens) return [];
		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of model.sqlTokens) {
			if (tok.type !== 'VAR') continue;
			const word = text.slice(tok.start, tok.end + 1);
			if (!LEGACY.has(word.toLowerCase())) continue;

			const start = lineOffset(text, tok.start);
			const end = lineOffset(text, tok.end + 1);

			violations.push({
				rule: 'ninja.convention.coalesce',
				message: `Use COALESCE instead of ${word.toUpperCase()}.`,
				range: new vscode.Range(start.line, start.col, end.line, end.col),
				fix: [{
					range: new vscode.Range(start.line, start.col, end.line, end.col),
					newText: 'coalesce',
				}],
			});
		}

		return violations;
	},
};
