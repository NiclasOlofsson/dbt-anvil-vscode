import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const unusedJoinRule: TokenRule = {
	id: 'ninja.structure.unused-join',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'warning',
	description: 'JOINed table is never referenced by any column.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		// Collect all table refs — first one is FROM, rest are JOINs
		const tableRefs = model.tokens.filter(t => t.type === 'table_ref');
		if (tableRefs.length < 2) return [];

		// All column qualifiers
		const usedQualifiers = new Set<string>();
		for (const tok of model.tokens) {
			if (tok.type === 'column_ref' && tok.table) {
				usedQualifiers.add(tok.table.toLowerCase());
			}
		}

		// Skip the first table_ref (FROM source) — only check JOINed tables
		for (let i = 1; i < tableRefs.length; i++) {
			const tr = tableRefs[i];
			const label = tr.alias ?? tr.name;
			if (usedQualifiers.has(label.toLowerCase())) continue;

			violations.push({
				rule: 'ninja.structure.unused-join',
				message: `JOINed table '${tr.name}'${tr.alias ? ` (alias '${tr.alias}')` : ''} is never referenced in column expressions.`,
				range: new vscode.Range(tr.line, tr.col, tr.line, tr.endCol),
			});
		}

		return violations;
	},
};
