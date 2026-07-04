import type { RefInfo, SourceInfo, TableRefToken, TokenInfo } from '../../services/parse-service';

/**
 * Cross-reference jinja tags ↔ table_ref tokens after AST extraction:
 *
 *   - Expand each token's `endCol` to cover the full `{{ ... }}` span so
 *     hover/diagnostic ranges include the closing braces.
 *   - Back-fill `alias` on the matching `RefInfo`/`SourceInfo` from the
 *     AST-derived token, since jinja-spans don't see SQL aliases.
 *
 * Mutates both `tokens` and the entries of `refs`/`sources` in place.
 */
export function enrichTokensWithJinjaSpans(
	tokens: TokenInfo[],
	refs: RefInfo[],
	sources: SourceInfo[],
): void {
	// Match the table_ref by POSITION (line + col of the `{{`), not by name. Under the
	// blank cascade the FROM identifier IS the model name (blankJinja substitutes it), but
	// under the native parseTemplated path it is an opaque placeholder (`jjj…`) occupying the
	// tag's char range — so a name equality would miss it. The tag's start position is unique
	// to the one table it stands for, so line+col identifies it under either scheme.
	for (const ref of refs) {
		const tok = tokens.find((t): t is TableRefToken =>
			t.type === 'table_ref' && t.line === ref.line && t.col === ref.jinjaCol,
		);
		if (tok && ref.jinjaEndCol !== undefined) {
			tok.endCol = ref.jinjaEndCol;
			if (tok.alias && tok.alias !== ref.model) ref.alias = tok.alias;
		}
	}
	for (const src of sources) {
		const tok = tokens.find((t): t is TableRefToken =>
			t.type === 'table_ref' && t.line === src.line && t.col === src.jinjaCol,
		);
		if (tok && src.jinjaEndCol !== undefined) {
			tok.endCol = src.jinjaEndCol;
			if (tok.alias && tok.alias !== src.tableName) src.alias = tok.alias;
		}
	}
}
