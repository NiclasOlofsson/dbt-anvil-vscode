import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';

export const unionStyleRule: TokenRule = {
	id: 'ninja.convention.union-style',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Enforce consistent UNION qualifier style (ALL vs DISTINCT).',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'convention.unionStyle', label: 'Preferred', type: 'enum', choices: ['all', 'distinct'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];
		const preferred = config.convention.unionStyle; // 'all' | 'distinct'

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'UNION') continue;

			const next = tokens[i + 1];
			if (!next) continue;
			if (next.type !== 'ALL' && next.type !== 'DISTINCT') continue;

			const actual = next.type.toLowerCase() as 'all' | 'distinct';
			if (actual === preferred) continue;

			const lo = lineOffset(text, next.line);
			const raw = text.slice(next.start, next.end + 1);
			const col = next.start - lo;
			const range = new vscode.Range(next.line, col, next.line, col + raw.length);

			violations.push({
				rule: 'ninja.convention.union-style',
				message: `Use UNION ${preferred.toUpperCase()} — UNION ${actual.toUpperCase()} conflicts with the configured style.`,
				range,
				action: { type: FixAction.TYPE, edits: [{ range, newText: preferred.toUpperCase() }], autoFix: true },
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
