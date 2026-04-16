import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

const JOIN_QUALIFIERS = new Set(['INNER', 'LEFT', 'RIGHT', 'CROSS', 'FULL', 'NATURAL']);

export const implicitJoinRule: TokenRule = {
	id: 'ninja.ambiguity.implicit-join',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'warning',
	description: 'Use explicit JOIN qualifiers (INNER, LEFT, etc.) instead of bare JOIN.',
	fixes: 'auto',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'JOIN') continue;

			const prev = tokens[i - 1];
			if (prev && JOIN_QUALIFIERS.has(prev.type)) continue;

			const tok = tokens[i];
			const lo = lineOffset(text, tok.line);
			const raw = text.slice(tok.start, tok.end + 1);
			const col = tok.start - lo;
			const range = new vscode.Range(tok.line, col, tok.line, col + raw.length);
			violations.push({
				rule: 'ninja.ambiguity.implicit-join',
				message: 'Use INNER JOIN instead of bare JOIN.',
				range,
				fix: [{
					range,
					newText: `INNER ${raw}`,
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
