import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import { tokenRange, tokenText } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

/**
 * RF04 — SQL keywords used as unquoted identifiers are a portability hazard.
 *
 * sqlglot normally tokenizes reserved words as their own keyword token type,
 * but in certain contexts (e.g. after AS, or as aliases) the parser emits them
 * as VAR tokens because the context allows it. When a VAR token's text matches
 * a known SQL keyword, flag it — wrapping with quotes is safer.
 */
const RESERVED_KEYWORDS = new Set([
	'date', 'time', 'timestamp', 'name', 'value', 'type',
	'status', 'order', 'select', 'from', 'where', 'join',
]);

export const keywordsAsIdentifiersRule: TokenRule = {
	id: 'ninja.reference.keywords-as-identifiers',
	type: 'token',
	category: NinjaCategory.Reference,
	defaultSeverity: 'warning',
	description: 'SQL keywords used as unquoted identifiers are a portability hazard.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		const tokens = sqlOnly(model.ninjaSqlTokens);
		if (tokens.length === 0) return [];

		const text = document.getText();
		const violations: NinjaViolation[] = [];

		for (const tok of tokens) {
			if (tok.type !== 'VAR') continue;

			const raw = tokenText(text, tok);
			if (!RESERVED_KEYWORDS.has(raw.toLowerCase())) continue;

			const range = tokenRange(text, tok);
			violations.push({
				rule: 'ninja.reference.keywords-as-identifiers',
				message: `'${raw}' is a SQL keyword used as an unquoted identifier — consider quoting it for portability.`,
				range,
			});
		}

		return violations;
	},
};
