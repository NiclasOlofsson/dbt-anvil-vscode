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

		// A relation's `.alias` only ever comes from a real alias written in source —
		// nothing here to synthesize, unlike the old qualify()-based bridge which could
		// invent aliases for ref/source tables.
		const aliasedRelations = (model.symbols ?? []).filter(
			s => (s.kind === 'table' || s.kind === 'cte' || s.kind === 'subquery' || s.kind === 'lateral')
				&& s.modifiers.includes('reference') && s.alias !== undefined,
		);
		if (aliasedRelations.length === 0) return [];

		// Collect the qualifiers actually referenced by column reads, resolved via
		// `.source` (works uniformly for qualified AND bare columns — the same
		// resolution the old bridge's `.table` used).
		const usedQualifiers = new Set<string>();
		for (const s of model.symbols ?? []) {
			if (s.kind !== 'column' || !s.modifiers.includes('reference')) continue;
			const relation = s.source;
			if (!relation) continue;
			const qualifier = relation.alias?.name ?? relation.name;
			usedQualifiers.add(qualifier.toLowerCase());
		}

		// Flag aliases not referenced in any column qualifier
		for (const relation of aliasedRelations) {
			const alias = relation.alias!;
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
