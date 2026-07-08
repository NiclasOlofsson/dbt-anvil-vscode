import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { Sym } from '../../ftl/sqllens/api';

export const uniqueTableRule: TokenRule = {
	id: 'ninja.aliasing.unique-table',
	type: 'token',
	category: NinjaCategory.Aliasing,
	defaultSeverity: 'warning',
	description: 'Table aliases must be unique within a query.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model } = ctx;
		const violations: NinjaViolation[] = [];

		// Per-scope seen maps, keyed by `sym.frame` directly — sqllens's own symbol
		// walk already assigns each FROM/JOIN reference the CTE/subquery/main-query
		// scope it lives in, handling nesting (subqueries, set-op branches, pipe
		// stages) correctly, so there is no need to re-derive scope from CTE line ranges.
		const seenByFrame = new Map<string, Map<string, { span: Sym['span'] }>>();

		for (const relSym of model.symbols ?? []) {
			if (relSym.kind !== 'table' && relSym.kind !== 'cte') continue;
			if (!relSym.modifiers.includes('reference')) continue;

			const aliasSym = relSym.alias;
			const label = aliasSym?.name ?? relSym.name;
			const key = label.toLowerCase();

			let seen = seenByFrame.get(relSym.frame);
			if (!seen) { seen = new Map(); seenByFrame.set(relSym.frame, seen); }

			const prev = seen.get(key);
			if (prev) {
				const target = aliasSym ?? relSym;
				const range = new vscode.Range(
					target.span.line - 1, target.span.column,
					target.span.endLine - 1, target.span.endColumn,
				);
				violations.push({
					rule: 'ninja.aliasing.unique-table',
					message: `Duplicate table alias '${label}'.`,
					range,
				});
			} else {
				seen.set(key, aliasSym ?? relSym);
			}
		}

		return violations;
	},
};
