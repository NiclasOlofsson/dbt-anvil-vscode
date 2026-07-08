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

		for (const relSym of model.symbols ?? []) {
			if (relSym.kind !== 'table' && relSym.kind !== 'cte') continue;
			if (!relSym.modifiers.includes('reference')) continue;

			const aliasSym = relSym.alias;
			if (!aliasSym) continue;
			if (relSym.name.toLowerCase() !== aliasSym.name.toLowerCase()) continue;

			// Range covering the alias identifier itself
			const range = new vscode.Range(
				aliasSym.span.line - 1, aliasSym.span.column,
				aliasSym.span.endLine - 1, aliasSym.span.endColumn,
			);

			// Fix: remove the alias span (from after table name to end of alias)
			const fixRange = new vscode.Range(
				relSym.span.endLine - 1, relSym.span.endColumn,
				aliasSym.span.endLine - 1, aliasSym.span.endColumn,
			);
			violations.push({
				rule: 'ninja.aliasing.self-alias',
				message: `Table '${relSym.name}' is aliased to itself — remove the alias.`,
				range,
				action: { type: FixAction.TYPE, ops: [deleteOp(fixRange)], autoFix: true },
			});
		}

		return violations;
	},
};
