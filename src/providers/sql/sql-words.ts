import type { DialectSymbols } from '../../ftl/sql-tokens';

/**
 * True when `word` is a SQL keyword or built-in function for the active dialect —
 * i.e. NOT a user column/identifier. Hover and Find-All-References use it to skip
 * words that only look like columns.
 *
 * Dialect-aware by design: the keyword/function sets come from sqllens via
 * `ParseService.getDialectSymbols()`, so `ifnull` is a non-column word under
 * Databricks but a plain identifier under Postgres. Replaces the old dialect-blind
 * hardcoded `SQL_KEYWORDS` list, which was wrong for every dialect at once.
 *
 * When symbols are unavailable (cold start, or a parser without symbol support)
 * nothing is suppressed: a missing dialect must never fabricate a keyword verdict.
 */
export function isSqlKeywordOrFunction(word: string, symbols: DialectSymbols | undefined): boolean {
	if (!symbols) return false;
	const w = word.toLowerCase();
	return symbols.keywords.has(w) || symbols.functions.has(w);
}
