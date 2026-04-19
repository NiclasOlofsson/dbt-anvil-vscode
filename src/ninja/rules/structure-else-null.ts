import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { offsetToLineCol } from '../token-utils';

export const elseNullRule: TokenRule = {
	id: 'ninja.structure.else-null',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'info',
	description: 'Redundant ELSE NULL — CASE already returns NULL by default.',
	actionKinds: ['fix'],
	autoFixable: true,

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

			const elseStart = offsetToLineCol(text, tokens[i].start);
			const nullEnd = offsetToLineCol(text, tokens[i + 1].end + 1);
			const endStart = offsetToLineCol(text, tokens[i + 2].start);

			// Fix removes from ELSE start to just before END
			violations.push({
				rule: 'ninja.structure.else-null',
				message: 'Redundant ELSE NULL — CASE returns NULL by default.',
				range: new vscode.Range(elseStart.line, elseStart.col, nullEnd.line, nullEnd.col),
				action: { type: FixAction.TYPE, edits: [{ range: new vscode.Range(elseStart.line, elseStart.col, endStart.line, endStart.col), newText: '' }], autoFix: true },
			});
		}

		return violations;
	},
};
