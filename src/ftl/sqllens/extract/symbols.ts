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

/** One arm's join surface for `backfillSymAliases`: the arm's own analyzed
 *  symbols (arm-local `Sym.node` identities), its realization's tags, and its
 *  guaranteed tag→node join. */
export interface AliasBackfillArm {
	symbols: Sym[];
	tags: TagNode[];
	nodeOf: (tag: TagNode) => object | undefined;
}

/**
 * Back-fill `alias` onto ref/source infos (built from the PRIMARY tag-AST,
 * which sees jinja tags but never SQL aliases) from the matching relation
 * Sym's own alias binding.
 *
 * Joined by IDENTITY within each ARM (variant-wave A2): an arm's
 * `nodeOf(tag)` → `Sym.node` join is guaranteed in that arm's own parse,
 * where the primary's is only best-effort under conflicting arms. Arm tags
 * correlate to primary infos by the tag's OPENING OFFSET (`tagSpan.start`):
 * realizations are coordinate-preserving, so the same tag opens at the same
 * offset in every arm — an exact shared key, not a heuristic. Primary
 * tag→info correlation is by INDEX (`tagInfos` produces refs/sources 1:1 in
 * tag order — invariant shared with tag-infos.ts). First arm to answer an
 * alias wins; a self-named alias (`orders as orders`) is not an alias — same
 * rule the old position probe applied.
 */
export function backfillSymAliases(
	refs: RefInfo[],
	sources: SourceInfo[],
	primaryTags: TagNode[],
	arms: AliasBackfillArm[],
): void {
	const infoByStart = new Map<number, RefInfo | SourceInfo>();
	let refIdx = 0;
	let srcIdx = 0;
	for (const tag of primaryTags) {
		if (tag.kind === 'ref') infoByStart.set(tag.tagSpan.start, refs[refIdx++]);
		else if (tag.kind === 'source') infoByStart.set(tag.tagSpan.start, sources[srcIdx++]);
	}

	for (const arm of arms) {
		const symByNode = new Map<object, Sym>();
		for (const s of arm.symbols) {
			if (RELATION_KINDS.has(s.kind) && s.modifiers.includes('reference') && s.node !== undefined) {
				symByNode.set(s.node, s);
			}
		}
		for (const tag of arm.tags) {
			if (tag.kind !== 'ref' && tag.kind !== 'source') continue;
			const info = infoByStart.get(tag.tagSpan.start);
			if (!info || info.alias !== undefined) continue;
			const node = arm.nodeOf(tag);
			const alias = node ? symByNode.get(node)?.alias?.name : undefined;
			if (!alias) continue;
			const selfName = 'model' in info ? info.model : info.tableName;
			if (alias !== selfName) info.alias = alias;
		}
	}
}
