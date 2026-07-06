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

		// aliasOf only ever pairs a relation-kind reference Sym (table/cte/subquery/lateral)
		// with a real alias Sym written in source — nothing here to synthesize, unlike the
		// old qualify()-based bridge which could invent aliases for ref/source tables.
		const aliasOf = model.symbolBindings?.aliasOf ?? new Map();
		if (aliasOf.size === 0) return [];

		// Collect the qualifiers actually referenced by column reads, resolved via
		// sourceOf (works uniformly for qualified AND bare columns — the same
		// qualification.bindingOf-based resolution the old bridge's `.table` used).
		const usedQualifiers = new Set<string>();
		for (const s of model.symbols ?? []) {
			if (s.kind !== 'column' || !s.modifiers.includes('reference')) continue;
			const relation = model.symbolBindings?.sourceOf.get(s);
			if (!relation) continue;
			const qualifier = aliasOf.get(relation)?.name ?? relation.name;
			usedQualifiers.add(qualifier.toLowerCase());
		}

		// Flag aliases not referenced in any column qualifier
		for (const [relation, alias] of aliasOf) {
			if (usedQualifiers.has(alias.name.toLowerCase())) continue;
			const range = new vscode.Range(alias.span.line - 1, alias.span.column, alias.span.endLine - 1, alias.span.endColumn);
			violations.push({
				rule: 'ninja.aliasing.unused-alias',
				message: `Alias '${alias.name}' for table '${relation.name}' is never referenced.`,
				range,
			});
		}

		return violations;
	},
};
