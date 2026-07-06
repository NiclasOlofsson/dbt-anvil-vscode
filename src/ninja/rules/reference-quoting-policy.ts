import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange, tokenText } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * RF06 — Identifiers should be consistently quoted or unquoted.
 *
 * If most identifiers in the query are unquoted, flag quoted identifiers whose
 * inner content is a plain identifier (only letters, digits, and underscores,
 * starting with a letter or underscore). Those identifiers do not need quotes
 * and their quoting is inconsistent with the rest of the query.
 */

/** Token types for quoted identifiers. */
const QUOTED_TYPES = new Set(['QUOTED_IDENTIFIER', 'BACKTICK']);

/** Token types for unquoted identifiers and variables. */
const UNQUOTED_TYPES = new Set(['VAR', 'IDENTIFIER']);

/** Matches identifiers that are safe to write without quotes. */
const PLAIN_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Strip the surrounding quote character(s) from a quoted token's raw text. */
function stripQuotes(raw: string): string {
	if (raw.length < 2) return raw;
	const first = raw[0];
	const last = raw[raw.length - 1];
	if ((first === '"' && last === '"') || (first === '`' && last === '`') || (first === '\'' && last === '\'')) {
		return raw.slice(1, -1);
	}
	return raw;
}

export const quotingPolicyRule: TokenRule = {
	id: 'ninja.reference.quoting-policy',
	type: 'token',
	category: NinjaCategory.Reference,
	defaultSeverity: 'hint',
	description: 'Unnecessary quoting — this identifier can be written without quotes.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();

		let unquotedCount = 0;
		let quotedCount = 0;

		for (const tok of tokens) {
			if (UNQUOTED_TYPES.has(tok.type)) unquotedCount++;
			else if (QUOTED_TYPES.has(tok.type)) quotedCount++;
		}

		// Only flag when the majority of identifiers are unquoted.
		// If there are no unquoted identifiers, or quoted outnumber unquoted, skip.
		if (unquotedCount === 0 || quotedCount === 0) return [];
		if (quotedCount >= unquotedCount) return [];

		const violations: NinjaViolation[] = [];

		for (const tok of tokens) {
			if (!QUOTED_TYPES.has(tok.type)) continue;

			const raw = tokenText(text, tok);
			const inner = stripQuotes(raw);

			if (!PLAIN_IDENTIFIER_RE.test(inner)) continue;

			const range = tokenRange(text, tok);
			violations.push({
				rule: 'ninja.reference.quoting-policy',
				message: `Unnecessary quoting — '${inner}' can be written without quotes.`,
				range,
			});
		}

		return violations;
	},
};
