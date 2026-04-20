import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { lineOffset } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * CV09 — Blocked words / reserved identifiers.
 *
 * Opt-in rule. Reads a list of forbidden identifier names from
 * `config.convention.blockedWords` (not yet in the typed schema — checked via
 * type assertion). When the list is non-empty, flags any `VAR` / `IDENTIFIER`
 * token whose raw text matches one of the blocked words (case-insensitive).
 *
 * Use this to ban deprecated column names, platform-specific functions, or any
 * project-specific conventions that should be avoided.
 */
export const blockedWordsRule: TokenRule = {
	id: 'ninja.convention.blocked-words',
	type: 'token',
	category: NinjaCategory.Convention,
	defaultSeverity: 'warning',
	description: 'Flag usage of configured blocked words / identifiers.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document, config } = ctx;

		// Read blocked words from config — opt-in, returns early when not set.
		const blockedWords: string[] | undefined =
			(config as unknown as { convention?: { blockedWords?: unknown } }).convention?.blockedWords as string[] | undefined;
		if (!Array.isArray(blockedWords) || blockedWords.length === 0) return [];

		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		// Build a lowercased set for O(1) lookup.
		const blocked = new Set(blockedWords.map(w => w.toLowerCase()));

		// Identifier-like token types emitted by sqlglot.
		const ID_TYPES = new Set(['VAR', 'IDENTIFIER', 'PARAMETER', 'TABLE', 'COLUMN']);

		for (const tok of tokens) {
			if (!ID_TYPES.has(tok.type)) continue;

			const raw = text.slice(tok.start, tok.end + 1);
			if (!blocked.has(raw.toLowerCase())) continue;

			const lo = lineOffset(text, tok.line);
			const range = new vscode.Range(
				tok.line, tok.start - lo,
				tok.line, tok.end + 1 - lo,
			);
			violations.push({
				rule: 'ninja.convention.blocked-words',
				message: `'${raw}' is a blocked word and should not be used.`,
				range,
			});
		}

		return violations;
	},
};
