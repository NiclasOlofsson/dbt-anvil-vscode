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
import type { Dialect, ScopeTree, SchemaProvider, StarExpansion, Sym, TagNode } from '../api';
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
 * `backfillTagAliases`.
 *
 * Joined by IDENTITY, not position (stage-1 Of-accessors): `nodeOf(tag)` gives
 * the IR node the tag filled, `Sym.node` carries the node a relation Sym
 * describes — one Map lookup joins them. Tag→info correlation is by INDEX:
 * `tagInfos` produces refs/sources 1:1 in tag order from this same `tags`
 * array, so the i-th ref tag IS `refs[i]` (invariant shared with tag-infos.ts).
 * A self-named alias (`orders as orders`) is not an alias — same rule the old
 * position probe applied.
 */
export function backfillSymAliases(
	symbols: Sym[],
	refs: RefInfo[],
	sources: SourceInfo[],
	tags: TagNode[],
	nodeOf: (tag: TagNode) => object | undefined,
): void {
	const symByNode = new Map<object, Sym>();
	for (const s of symbols) {
		if (RELATION_KINDS.has(s.kind) && s.modifiers.includes('reference') && s.node !== undefined) {
			symByNode.set(s.node, s);
		}
	}
	const aliasOf = (tag: TagNode): string | undefined => {
		const node = nodeOf(tag);
		return node ? symByNode.get(node)?.alias?.name : undefined;
	};

	let refIdx = 0;
	let srcIdx = 0;
	for (const tag of tags) {
		if (tag.kind === 'ref') {
			const info = refs[refIdx++];
			const alias = aliasOf(tag);
			if (alias && alias !== info.model) info.alias = alias;
		} else if (tag.kind === 'source') {
			const info = sources[srcIdx++];
			const alias = aliasOf(tag);
			if (alias && alias !== info.tableName) info.alias = alias;
		}
	}
}
