import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { deleteOp } from '../fix-op';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * CV06 — No statement terminators in dbt models.
 *
 * dbt renders each model as an individual statement that is sent to the
 * database without a surrounding script runner, so trailing semicolons are
 * unnecessary and can cause errors with some adapters. Flag every SEMICOLON
 * token and offer to delete it.
 */
export const statementTerminatorRule: TokenRule = {
	id: 'ninja.convention.statement-terminator',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'hint',
	description: 'Semicolons are not needed in dbt models.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of tokens) {
			if (tok.type !== 'SEMICOLON') continue;

			const lo = lineOffset(text, tok.line);
			const range = new vscode.Range(
				tok.line, tok.start - lo,
				tok.line, tok.end + 1 - lo,
			);
			violations.push({
				rule: 'ninja.convention.statement-terminator',
				message: 'Semicolons are not needed in dbt models.',
				range,
				action: {
					type: FixAction.TYPE,
					ops: [deleteOp(range)],
					autoFix: true,
				},
			});
		}

		return violations;
	},
};
