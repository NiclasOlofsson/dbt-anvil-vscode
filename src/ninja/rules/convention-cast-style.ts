import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * CV11 — Consistent CAST style.
 *
 * Flags the PostgreSQL/DuckDB `::` shorthand (sqlglot token type `DCOLON`) and
 * suggests the standard `CAST(x AS type)` form instead. This keeps SQL more
 * portable across adapters that do not support the `::` operator.
 *
 * Detection only — no autofix, because the rewrite requires understanding the
 * surrounding expression structure.
 */
export const castStyleRule: TokenRule = {
	id: 'ninja.convention.cast-style',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'hint',
	description: 'Prefer CAST(x AS type) over the :: shorthand for portability.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of tokens) {
			if (tok.type !== 'DCOLON') continue;

			const lo = lineOffset(text, tok.line);
			const range = new vscode.Range(
				tok.line, tok.start - lo,
				tok.line, tok.end + 1 - lo,
			);
			violations.push({
				rule: 'ninja.convention.cast-style',
				message: 'Use CAST(x AS type) instead of the :: shorthand for cross-adapter portability.',
				range,
			});
		}

		return violations;
	},
};
