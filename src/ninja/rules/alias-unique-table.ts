import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

export const uniqueTableRule: TokenRule = {
	id: 'ninja.aliasing.unique-table',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'warning',
	description: 'Table aliases must be unique within a query.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		// Build per-scope seen maps: one per CTE body, one for the final SELECT.
		// A token belongs to the scope whose line range contains it; if no CTE
		// contains it, it belongs to the final-SELECT scope.
		const scopeFor = (line: number): string => {
			for (const cte of model.ctes) {
				if (line >= cte.line && line <= cte.endLine) return cte.name;
			}
			return '__final__';
		};

		const seenByScope = new Map<string, Map<string, { line: number; col: number }>>();

		for (const tok of model.tokens) {
			if (tok.type !== 'table_ref') continue;
			const label = tok.alias ?? tok.name;
			const key = label.toLowerCase();
			const scope = scopeFor(tok.line);

			let seen = seenByScope.get(scope);
			if (!seen) { seen = new Map(); seenByScope.set(scope, seen); }

			const line = tok.aliasLine ?? tok.line;
			const col = tok.aliasCol ?? tok.col;
			const endCol = tok.aliasEndCol ?? tok.endCol;

			const prev = seen.get(key);
			if (prev) {
				violations.push({
					rule: 'ninja.aliasing.unique-table',
					message: `Duplicate table alias '${label}'.`,
					range: new vscode.Range(line, col, line, endCol),
				});
			} else {
				seen.set(key, { line, col });
			}
		}

		return violations;
	},
};
