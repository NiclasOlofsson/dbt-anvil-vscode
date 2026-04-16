import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const notEqualRule: TokenRule = {
	id: 'ninja.convention.not-equal',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent not-equal operator style (!= or <>).',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const preferred = config.convention.notEqual;
		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of model.sqlTokens) {
			if (tok.type !== 'NEQ') continue;
			const raw = text.slice(tok.start, tok.end + 1);
			if (raw === preferred) continue;

			const range = new vscode.Range(tok.line, tok.start - lineOffset(text, tok.line), tok.line, tok.start - lineOffset(text, tok.line) + raw.length);
			violations.push({
				rule: 'ninja.convention.not-equal',
				message: `Use '${preferred}' instead of '${raw}'.`,
				range,
				fix: [{
					range,
					newText: preferred,
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
