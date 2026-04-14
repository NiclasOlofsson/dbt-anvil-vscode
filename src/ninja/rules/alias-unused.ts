import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const unusedAliasRule: TokenRule = {
	id: 'ninja.aliasing.unused-alias',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'info',
	description: 'Table alias is defined but never referenced by any column.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		// Collect all table aliases
		const aliased: { name: string; alias: string; line: number; col: number; endCol: number }[] = [];
		for (const tok of model.tokens) {
			if (tok.type !== 'table_ref' || !tok.alias) continue;
			aliased.push({
				name: tok.name,
				alias: tok.alias,
				line: tok.aliasLine ?? tok.line,
				col: tok.aliasCol ?? tok.col,
				endCol: tok.aliasEndCol ?? tok.endCol,
			});
		}
		if (aliased.length === 0) return [];

		// Collect all table qualifiers from column refs
		const usedQualifiers = new Set<string>();
		for (const tok of model.tokens) {
			if (tok.type === 'column_ref' && tok.table) {
				usedQualifiers.add(tok.table.toLowerCase());
			}
		}

		// Flag aliases not referenced in any column qualifier
		for (const a of aliased) {
			if (usedQualifiers.has(a.alias.toLowerCase())) continue;
			violations.push({
				rule: 'ninja.aliasing.unused-alias',
				message: `Alias '${a.alias}' for table '${a.name}' is never referenced.`,
				range: new vscode.Range(a.line, a.col, a.line, a.endCol),
			});
		}

		return violations;
	},
};
