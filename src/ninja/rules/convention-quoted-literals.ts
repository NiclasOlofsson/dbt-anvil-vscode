import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * CV10 — Consistent quote style for string literals.
 *
 * By default, prefers single-quoted string literals (`'text'`). sqlglot emits:
 *   - `SINGLE_QUOTE`  for  'text'
 *   - `DOUBLE_QUOTE`  for  "text"  (when used as a string, not an identifier)
 *
 * The rule flags `DOUBLE_QUOTE` tokens and suggests using single quotes.
 * Quote normalisation is intentionally left to the user (no autofix) because
 * the content may contain the preferred quote character as an escaped literal.
 *
 * Config: if `(config as any).convention?.quoteStyle` is present and set to
 * `'double'`, the check is inverted — single quotes are flagged instead.
 */
export const quotedLiteralsRule: TokenRule = {
	id: 'ninja.convention.quoted-literals',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'hint',
	description: 'Prefer consistent quote style for string literals (default: single quotes).',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// Read optional quoteStyle from config (not yet in the typed schema — use
		// type assertion so the rule stays forward-compatible when it is added).
		const quoteStyle: 'single' | 'double' =
			(config as unknown as { convention?: { quoteStyle?: string } }).convention?.quoteStyle === 'double'
				? 'double'
				: 'single';

		const badType = quoteStyle === 'single' ? 'DOUBLE_QUOTE' : 'SINGLE_QUOTE';
		const preferredChar = quoteStyle === 'single' ? "'" : '"';

		for (const tok of tokens) {
			if (tok.type !== badType) continue;

			const lo = lineOffset(text, tok.line);
			const range = new vscode.Range(
				tok.line, tok.start - lo,
				tok.line, tok.end + 1 - lo,
			);
			violations.push({
				rule: 'ninja.convention.quoted-literals',
				message: `Use ${preferredChar === "'" ? 'single' : 'double'}-quoted string literals (${preferredChar}text${preferredChar}).`,
				range,
			});
		}

		return violations;
	},
};
