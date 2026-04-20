import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import { tokenRange } from '../token-utils';
import type { SqlToken } from '../../ftl/parse-result';

const RULE_ID = 'ninja.layout.select-modifiers';

/** Modifiers that must appear on the same line as SELECT. */
const SELECT_MODIFIERS = new Set(['DISTINCT', 'TOP']);

export const selectModifiersRule: TokenRule = {
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Layout,
	defaultSeverity: 'warning',
	description: 'DISTINCT and TOP should appear on the same line as SELECT (LT10)',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const sqlTokens = sqlOnly(ctx.model.ninjaSqlTokens);
		if (sqlTokens.length === 0) return [];

		const violations: NinjaViolation[] = [];
		const text = ctx.document.getText();

		for (let i = 0; i < sqlTokens.length; i++) {
			const tok = sqlTokens[i];
			if (tok.type.toUpperCase() !== 'SELECT') continue;

			// Find the next non-whitespace SQL token after SELECT.
			// sqlglot tokens do not include whitespace tokens, so the very
			// next entry in the stream is already the first significant token.
			const next = sqlTokens[i + 1];
			if (!next) continue;

			const nextType = next.type.toUpperCase();
			if (SELECT_MODIFIERS.has(nextType) && next.line !== tok.line) {
				const range = tokenRange(text, next as SqlToken);
				violations.push({
					rule: RULE_ID,
					message: `'${nextType}' should be on the same line as SELECT, not on a new line`,
					range,
				});
			}
		}

		return violations;
	},
};
