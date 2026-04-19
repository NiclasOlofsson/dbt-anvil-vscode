import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { lineOffset, tokenRange } from '../token-utils';

export const outerJoinRule: TokenRule = {
	id: 'ninja.convention.outer-join',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Remove redundant OUTER keyword — LEFT/RIGHT/FULL already imply outer semantics.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];

		for (let i = 1; i < tokens.length - 1; i++) {
			if (tokens[i].type !== 'OUTER') continue;
			const prev = tokens[i - 1].type;
			if (prev !== 'LEFT' && prev !== 'RIGHT' && prev !== 'FULL') continue;
			if (tokens[i + 1].type !== 'JOIN') continue;

			const outerRange = tokenRange(text, tokens[i]);
			const joinTok = tokens[i + 1];
			const joinLo = lineOffset(text, joinTok.line);
			// Delete from start of OUTER up to (but not including) JOIN
			const fixRange = new vscode.Range(outerRange.start, new vscode.Position(joinTok.line, joinTok.start - joinLo));

			violations.push({
				rule: 'ninja.convention.outer-join',
				message: 'OUTER is redundant — use LEFT JOIN, RIGHT JOIN, or FULL JOIN.',
				range: outerRange,
				action: { type: FixAction.TYPE, edits: [{ range: fixRange, newText: '' }], autoFix: true },
			});
		}

		return violations;
	},
};
