import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const countRowsRule: TokenRule = {
	id: 'ninja.convention.count-rows',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Use COUNT(*) instead of COUNT(1) for row counts.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length - 3; i++) {
			const t = tokens[i];
			// Match: VAR(count) + L_PAREN + NUMBER(1) + R_PAREN
			if (t.type !== 'VAR') continue;
			const raw = text.slice(t.start, t.end + 1);
			if (raw.toLowerCase() !== 'count') continue;

			const lp = tokens[i + 1];
			const num = tokens[i + 2];
			const rp = tokens[i + 3];
			if (lp.type !== 'L_PAREN' || num.type !== 'NUMBER' || rp.type !== 'R_PAREN') continue;
			if (text.slice(num.start, num.end + 1) !== '1') continue;

			const lo = lineOffset(text, num.line);
			const range = new vscode.Range(num.line, num.start - lo, num.line, num.end + 1 - lo);
			violations.push({
				rule: 'ninja.convention.count-rows',
				message: 'Use COUNT(*) instead of COUNT(1).',
				range,
				fix: [{
					range,
					newText: '*',
				}],
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
