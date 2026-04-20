import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

export const distinctParensRule: TokenRule = {
	id: 'ninja.structure.distinct-parens',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'warning',
	description: 'DISTINCT is not a function — remove unnecessary parentheses.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (let i = 0; i < tokens.length - 1; i++) {
			if (tokens[i].type !== 'DISTINCT') continue;
			if (tokens[i + 1].type !== 'L_PAREN') continue;

			// Find matching R_PAREN — simple: next closing paren at same depth
			const lparen = tokens[i + 1];
			let depth = 1;
			let rparenIdx = -1;
			for (let j = i + 2; j < tokens.length; j++) {
				if (tokens[j].type === 'L_PAREN') depth++;
				else if (tokens[j].type === 'R_PAREN') {
					depth--;
					if (depth === 0) { rparenIdx = j; break; }
				}
			}
			if (rparenIdx === -1) continue;

			// Check there's no comma inside — DISTINCT(a, b) is okay-ish although weird
			// Actually DISTINCT(col) is the main case to fix. Multi-column = normal SELECT DISTINCT col1, col2
			// We only flag if the content between parens has NO commas (single-column case)
			let hasComma = false;
			for (let j = i + 2; j < rparenIdx; j++) {
				if (tokens[j].type === 'COMMA') { hasComma = true; break; }
			}
			if (hasComma) continue;

			const rparen = tokens[rparenIdx];
			const loLp = lineOffset(text, lparen.line);
			const loRp = lineOffset(text, rparen.line);
			const lparenRange = new vscode.Range(lparen.line, lparen.start - loLp, lparen.line, lparen.start - loLp + 1);
			const rparenRange = new vscode.Range(rparen.line, rparen.start - loRp, rparen.line, rparen.start - loRp + 1);

			// Report on the opening paren
			const lo = lineOffset(text, tokens[i].line);
			const range = new vscode.Range(tokens[i].line, tokens[i].start - lo, rparen.line, rparen.start - loRp + 1);
			violations.push({
				rule: 'ninja.structure.distinct-parens',
				message: 'DISTINCT is not a function — remove parentheses.',
				range,
				action: { type: FixAction.TYPE, edits: [{ range: rparenRange, newText: '' }, { range: lparenRange, newText: ' ' }], autoFix: true },
			});
		}

		return violations;
	},
};
