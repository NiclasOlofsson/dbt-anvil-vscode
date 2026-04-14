import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const leftJoinRule: TokenRule = {
	id: 'ninja.convention.left-join',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Prefer LEFT JOIN over RIGHT JOIN for readability.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length - 1; i++) {
			if (tokens[i].type !== 'RIGHT') continue;
			if (tokens[i + 1].type !== 'JOIN') continue;

			const lo = lineOffset(text, tokens[i].line);
			const range = new vscode.Range(
				tokens[i].line, tokens[i].start - lo,
				tokens[i].line, tokens[i].end + 1 - lo,
			);
			violations.push({
				rule: 'ninja.convention.left-join',
				message: 'Prefer LEFT JOIN over RIGHT JOIN — reorder tables instead.',
				range,
			});
		}

		return violations;
	},
};

function lineOffset(text: string, line: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) {
		const nl = text.indexOf('\n', offset);
		if (nl === -1) return offset;
		offset = nl + 1;
	}
	return offset;
}
