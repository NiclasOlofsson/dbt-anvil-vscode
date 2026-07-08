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

		// A FROM/JOIN source is kind 'table' (base table) or 'cte' (CTE reference),
		// always modifiers:['reference'] — this excludes the CTE's own declaration site.
		// Array order preserves source declaration order: first = FROM source, rest = JOINs.
		const tableRefs = (model.symbols ?? []).filter(
			s => (s.kind === 'table' || s.kind === 'cte') && s.modifiers.includes('reference'),
		);
		if (tableRefs.length < 2) return [];

		const columnRefs = (model.symbols ?? []).filter(
			s => s.kind === 'column' && s.modifiers.includes('reference'),
		);

		// All column qualifiers
		const usedQualifiers = new Set<string>();
		for (const col of columnRefs) {
			const resolved = col.source;
			if (!resolved) continue;
			const qualifier = resolved.alias?.name ?? resolved.name;
			usedQualifiers.add(qualifier.toLowerCase());
		}

		// Skip the first table_ref (FROM source) — only check JOINed tables
		for (let i = 1; i < tableRefs.length; i++) {
			const tr = tableRefs[i];
			const aliasSym = tr.alias;
			const label = aliasSym?.name ?? tr.name;
			if (usedQualifiers.has(label.toLowerCase())) continue;

			// No alias: columns from this table appear unqualified in SQL.
			// If unqualified column refs exist, they may come from this table — can't flag unused.
			if (!aliasSym) {
				const hasUnqualifiedRefs = columnRefs.some(c => !c.name.includes('.'));
				if (hasUnqualifiedRefs) continue;
			}

			const range = new vscode.Range(tr.span.line - 1, tr.span.column, tr.span.endLine - 1, tr.span.endColumn);
			violations.push({
				rule: 'ninja.structure.unused-join',
				message: `JOINed table '${tr.name}'${aliasSym ? ` (alias '${aliasSym.name}')` : ''} is never referenced in column expressions.`,
				range,
			});
		}

		return violations;
	},
};
