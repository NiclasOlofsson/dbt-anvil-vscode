import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';

export const isNullRule: TokenRule = {
	id: 'ninja.convention.is-null',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Use IS NULL / IS NOT NULL instead of = NULL / != NULL.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length - 1; i++) {
			const op = tokens[i];
			const nul = tokens[i + 1];
			if (nul.type !== 'NULL') continue;

			if (op.type === 'EQ') {
				const lo = lineOffset(text, op.line);
				const range = new vscode.Range(op.line, op.start - lo, nul.line, nul.end + 1 - lineOffset(text, nul.line));
				const raw = text.slice(nul.start, nul.end + 1);
				violations.push({
					rule: 'ninja.convention.is-null',
					message: 'Use IS NULL instead of = NULL.',
					range,
					action: { type: FixAction.TYPE, edits: [{ range, newText: `IS ${raw}` }], autoFix: true },
				});
			} else if (op.type === 'NEQ') {
				const lo = lineOffset(text, op.line);
				const range = new vscode.Range(op.line, op.start - lo, nul.line, nul.end + 1 - lineOffset(text, nul.line));
				const raw = text.slice(nul.start, nul.end + 1);
				violations.push({
					rule: 'ninja.convention.is-null',
					message: 'Use IS NOT NULL instead of != NULL.',
					range,
					action: { type: FixAction.TYPE, edits: [{ range, newText: `IS NOT ${raw}` }], autoFix: true },
				});
			}
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
