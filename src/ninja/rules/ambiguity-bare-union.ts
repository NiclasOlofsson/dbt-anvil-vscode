import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';

export const bareUnionRule: TokenRule = {
	id: 'ninja.ambiguity.bare-union',
	type: 'token',
	category: NinjaCategory.Ambiguity,
	defaultSeverity: 'warning',
	description: 'Use UNION ALL or UNION DISTINCT explicitly — bare UNION is ambiguous.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		if (!model.sqlTokens || model.sqlTokens.length === 0) return [];

		const text = document.getText();
		const tokens = model.sqlTokens;
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length; i++) {
			if (tokens[i].type !== 'UNION') continue;

			const next = tokens[i + 1];
			if (next && (next.type === 'ALL' || next.type === 'DISTINCT')) continue;

			const tok = tokens[i];
			const lo = lineOffset(text, tok.line);
			const raw = text.slice(tok.start, tok.end + 1);
			const col = tok.start - lo;
			const range = new vscode.Range(tok.line, col, tok.line, col + raw.length);
			const suffix = config.convention.unionStyle.toUpperCase();
			violations.push({
				rule: 'ninja.ambiguity.bare-union',
				message: `Use UNION ${suffix} instead of bare UNION.`,
				range,
				action: { type: FixAction.TYPE, edits: [{ range, newText: `${raw} ${suffix}` }], autoFix: true },
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
