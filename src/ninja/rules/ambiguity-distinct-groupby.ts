import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import * as vscode from 'vscode';

export const distinctGroupByRule: TokenRule = {
	id: 'ninja.ambiguity.distinct-groupby',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'info',
	description: 'Using DISTINCT with GROUP BY is redundant.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;

		let distinctToken = null;
		let hasGroupBy = false;

		for (const tok of tokens) {
			if (tok.type === 'DISTINCT' && !distinctToken) distinctToken = tok;
			if (tok.type === 'GROUP') hasGroupBy = true;
		}

		if (!distinctToken || !hasGroupBy) return [];

		const lo = lineOffset(text, distinctToken.line);
		const col = distinctToken.start - lo;
		const raw = text.slice(distinctToken.start, distinctToken.end + 1);
		const range = new vscode.Range(distinctToken.line, col, distinctToken.line, col + raw.length);

		return [{
			rule: 'ninja.ambiguity.distinct-groupby',
			message: 'DISTINCT is redundant when GROUP BY is present.',
			range,
		}];
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
