import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { replaceOp } from '../fix-op';
import { offsetToLineCol } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const LEGACY = new Set(['ifnull', 'nvl', 'isnull']);

export const coalesceRule: TokenRule = {
	id: 'ninja.convention.coalesce',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Use COALESCE instead of legacy null-handling functions (IFNULL, NVL, ISNULL).',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];
		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of tokens) {
			if (tok.type !== 'VAR') continue;
			const word = text.slice(tok.start, tok.end + 1);
			if (!LEGACY.has(word.toLowerCase())) continue;

			const start = offsetToLineCol(text, tok.start);
			const end = offsetToLineCol(text, tok.end + 1);

			violations.push({
				rule: 'ninja.convention.coalesce',
				message: `Use COALESCE instead of ${word.toUpperCase()}.`,
				range: new vscode.Range(start.line, start.col, end.line, end.col),
				action: { type: FixAction.TYPE, ops: [replaceOp(new vscode.Range(start.line, start.col, end.line, end.col), 'coalesce')], autoFix: true },
			});
		}

		return violations;
	},
};
