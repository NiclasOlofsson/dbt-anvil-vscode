import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import { FixAction, type NinjaViolation } from '../violation';
import { deleteOp } from '../fix-op';

export const selfAliasRule: TokenRule = {
	id: 'ninja.aliasing.self-alias',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'warning',
	description: 'Do not alias a table to its own name.',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		for (const tok of model.tokens) {
			if (tok.type !== 'table_ref') continue;
			if (!tok.alias) continue;
			if (tok.synthesized) continue;
			if (tok.isSubquery) continue;
			if (tok.name.toLowerCase() !== tok.alias.toLowerCase()) continue;

			const aliasLine = tok.aliasLine ?? tok.line;
			const aliasCol = tok.aliasCol ?? tok.endCol;
			const aliasEndCol = tok.aliasEndCol ?? aliasCol + tok.alias.length;

			// Range covering ` AS alias` or ` alias` — from end of table name to end of alias
			const range = new vscode.Range(aliasLine, aliasCol, aliasLine, aliasEndCol);

			// Fix: remove the alias span (from after table name to end of alias)
			const fixRange = new vscode.Range(tok.line, tok.endCol, aliasLine, aliasEndCol);
			violations.push({
				rule: 'ninja.aliasing.self-alias',
				message: `Table '${tok.name}' is aliased to itself — remove the alias.`,
				range,
				action: { type: FixAction.TYPE, ops: [deleteOp(fixRange)], autoFix: true },
			});
		}

		return violations;
	},
};
