import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';

/**
 * Flags `SELECT *` inside CTE bodies.
 *
 * SELECT * in CTEs defeats column-level analysis — the unused-columns
 * rule can't work when columns are opaque wildcards. This rule
 * encourages explicit column lists.
 *
 * Can be disabled via `structure.allowStarInCte: true` in config.
 */
export const selectStarRule: TokenRule = {
	id: 'ninja.structure.select-star',
	type: 'token',
	category: NinjaCategory.Structure,
	defaultSeverity: 'info',
	description: 'Avoid SELECT * inside CTEs — use explicit column lists.',
	configOptions: [{ settingPath: 'structure.allowStarInCte', label: 'Allow in CTE', type: 'bool' }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, config } = ctx;
		if (config.structure?.allowStarInCte) return [];
		if (model.ctes.length === 0) return [];

		const violations: NinjaViolation[] = [];

		for (const cte of model.ctes) {
			// A CTE with a '*' column was a SELECT * body
			const hasStar = cte.columns.some(c => c.name === '*');
			if (!hasStar) continue;

			const starCol = cte.columns.find(c => c.name === '*')!;
			const range = new vscode.Range(starCol.line, 0, starCol.line, 1);

			violations.push({
				rule: 'ninja.structure.select-star',
				message: `Avoid SELECT * in CTE '${cte.name}' — use explicit column lists.`,
				range,
			});
		}

		return violations;
	},
};
