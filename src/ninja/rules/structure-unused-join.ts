import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { TableRefToken } from '../../services/parse-service';

export const unusedJoinRule: TokenRule = {
	id: 'ninja.structure.unused-join',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'warning',
	description: 'JOINed table is never referenced by any column.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		// Collect only real FROM/JOIN refs — exclude CTE definition sites and qualify()-synthesized aliases
		const tableRefs = model.tokens.filter(
			t => t.type === 'table_ref' && !t.cteDefinition && !t.synthesized,
		) as TableRefToken[];
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

			// No alias: columns from this table appear unqualified in SQL.
			// If unqualified column refs exist, they may come from this table — can't flag unused.
			if (!tr.alias) {
				const hasUnqualifiedRefs = model.tokens.some(t => t.type === 'column_ref' && !t.table);
				if (hasUnqualifiedRefs) continue;
			}

			violations.push({
				rule: 'ninja.structure.unused-join',
				message: `JOINed table '${tr.name}'${tr.alias ? ` (alias '${tr.alias}')` : ''} is never referenced in column expressions.`,
				range: new vscode.Range(tr.line, tr.col, tr.line, tr.endCol),
			});
		}

		return violations;
	},
};
