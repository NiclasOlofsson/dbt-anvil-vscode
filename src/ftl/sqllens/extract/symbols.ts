/**
 * Sym-native symbol extraction (the successor to extract/tokens.ts's Sym → TokenInfo
 * bridge). `deriveSymbols` gives the canonical `Sym[]` for a parse directly from
 * sqllens, including a relation's alias (`Sym.alias`), a column reference's bound
 * source (`Sym.source`), and — given an `expandStarOf` callback (sqllens commit
 * 9c87f55) — one extra zero-width `column`/`["reference","star"]` Sym per resolved
 * `SELECT *` output column, alongside the existing opaque star Sym. This module is
 * now a thin pass-through plus the ref/source alias back-fill below; sqllens has no
 * way to do that half itself since it has no jinja-tag awareness.
 */
import { deriveSymbols } from '../api';
import type { Dialect, ScopeTree, SchemaProvider, StarExpansion, Sym } from '../api';
import type { RefInfo, SourceInfo } from '../../../services/parse-service';

/** The `SymbolKind` values `relationSymbol` (sqllens symbols.ts) produces — everything
 *  a FROM/JOIN source or CTE reference can be, i.e. every kind that can carry an alias. */
const RELATION_KINDS: ReadonlySet<Sym['kind']> = new Set(['table', 'cte', 'subquery', 'lateral']);

/**
 * Derive sqllens's native `Sym[]` for a parse. `expandStarOf` (typically
 * `Qualification.expandStarOf`, bound) is optional — without it a `SELECT *` stays a
 * single `star`-modifier Sym with no per-column breakdown, same as sqllens's own
 * default.
 */
export function extractSymbols(
	scopes: ScopeTree,
	dialect: Dialect,
	schema: SchemaProvider,
	expandStarOf?: StarExpansion,
): Sym[] {
	return deriveSymbols(scopes, schema, { dialect }, expandStarOf);
}

/**
 * Back-fill `alias` onto ref/source infos (built from the R2 tag-AST, which sees
 * jinja tags but never SQL aliases) from the matching relation Sym's own alias
 * binding — the Sym-native replacement for extract/tokens.ts's
 * `backfillTagAliases`. Matched by POSITION alone (line + the tag's own start
 * column): a templated relation's Sym.name is the length-preserving
 * placeholder's own displayName (sqllens has no template awareness), never the
 * canonical model/source name, so name matching — which the old TokenInfo
 * bridge could do because it substituted the canonical name in for templated
 * refs — doesn't carry over; position is the only anchor both sides share.
 */
export function backfillSymAliases(symbols: Sym[], refs: RefInfo[], sources: SourceInfo[]): void {
	const relationSyms = symbols.filter(s => RELATION_KINDS.has(s.kind) && s.modifiers.includes('reference'));
	const symAt = (line: number, col: number): Sym | undefined =>
		relationSyms.find(s => s.span.line - 1 === line && s.span.column === col);

	for (const ref of refs) {
		if (ref.jinjaCol === undefined) continue;
		const sym = symAt(ref.line, ref.jinjaCol);
		const alias = sym?.alias?.name;
		if (alias && alias !== ref.model) ref.alias = alias;
	}
	for (const src of sources) {
		if (src.jinjaCol === undefined) continue;
		const sym = symAt(src.line, src.jinjaCol);
		const alias = sym?.alias?.name;
		if (alias && alias !== src.tableName) src.alias = alias;
	}
}
