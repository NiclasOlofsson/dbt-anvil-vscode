/**
 * Sym-native symbol extraction (the successor to extract/tokens.ts's Sym → TokenInfo
 * bridge). `deriveSymbols` gives the canonical `Sym[]` for a parse directly from
 * sqllens, including a relation's alias (`Sym.alias`) and a column reference's bound
 * source (`Sym.source`) natively — this module's only remaining job is the star-
 * expansion synthetic-Sym pass below, which sqllens has no way to produce itself
 * (it never rewrites a `*` into explicit columns).
 */
import { deriveSymbols, displayName, MAIN_FRAME } from '../api';
import type { Dialect, ResolvedSource, Scope, ScopeTree, SchemaProvider, Sym } from '../api';
import { asCst, normName } from './spans';
import type { StarExpander } from './star-expand';
import type { RefInfo, SourceInfo } from '../../../services/parse-service';

/** The `SymbolKind` values `relationSymbol` (sqllens symbols.ts) produces — everything
 *  a FROM/JOIN source or CTE reference can be, i.e. every kind that can carry an alias. */
const RELATION_KINDS: ReadonlySet<Sym['kind']> = new Set(['table', 'cte', 'subquery', 'lateral']);

/**
 * Every scope's frame label, computed the same way sqllens's own symbol walk does
 * (sql-dialect-grammars/src/symbols/symbols.ts:85-139): a CTE body gets its CTE's
 * display name, a subquery its alias (or "_subquery_"), a graphtable its alias or
 * dotted graph path, set-op branches and pipe stages share their parent's frame,
 * and everything else (expression subqueries) falls back to "_sub_". Needed to
 * partition the flat `Sym[]` back into per-scope buckets below — no `Sym` field
 * says which scope produced it beyond this same frame string.
 */
function computeFrames(root: Scope, dialect: Dialect): Map<Scope, string> {
	const frames = new Map<Scope, string>();
	const visit = (scope: Scope, frame: string): void => {
		frames.set(scope, frame);
		for (const [, cteRef] of scope.ctes) visit(cteRef.scope, displayName(cteRef.def.name, dialect));
		if (scope.branches) {
			visit(scope.branches.left, frame);
			visit(scope.branches.right, frame);
		}
		if (scope.body.kind === 'pipe' && scope.pipe) {
			visit(scope.pipe.input, frame);
			for (const st of scope.pipe.stages) visit(st, frame);
		}
		for (const src of scope.sources.values()) {
			if (src.kind === 'subquery') {
				visit(src.scope, src.source.alias ? displayName(src.source.alias, dialect) : '_subquery_');
			} else if (src.kind === 'graphtable') {
				visit(src.scope, src.source.alias ?? src.source.graph.join('.'));
			}
		}
		for (const child of scope.children) {
			if (!frames.has(child)) visit(child, '_sub_');
		}
	};
	visit(root, MAIN_FRAME);
	return frames;
}

/** Every scope in the tree, root first — same traversal as spans.ts's `allScopes`,
 *  duplicated locally since it walks `Scope` objects directly rather than a `ScopeTree`. */
function allScopesOf(root: Scope): Scope[] {
	const out: Scope[] = [];
	const visit = (s: Scope): void => { out.push(s); for (const c of s.children) visit(c); };
	visit(root);
	return out;
}

/**
 * Derive sqllens's native `Sym[]` for a parse. Every column reference's `.source`
 * and every relation's `.alias` already come from `deriveSymbols` itself — the only
 * remaining work here is the star-expansion synthetic-Sym pass: sqllens never
 * rewrites a `*` into explicit columns, so a CTE consumed only through a downstream
 * `SELECT *` needs synthetic per-column Syms this function invents (see below).
 * `starExpander` is optional — without it a `SELECT *` stays a single `star`-modifier
 * Sym with no per-column breakdown.
 */
export function extractSymbols(
	scopes: ScopeTree,
	dialect: Dialect,
	schema: SchemaProvider,
	starExpander?: StarExpander,
): Sym[] {
	const symbols = deriveSymbols(scopes, schema, { dialect });
	if (!starExpander) return symbols;

	// Bucket symbols by frame, preserving emission order within each bucket. Filtering
	// by frame strips out whatever a nested recursion (a subquery's own body, say)
	// pushed in between, leaving each bucket in the same relative order as the
	// scope-tree data it came from.
	const byFrame = new Map<string, Sym[]>();
	for (const sym of symbols) {
		const bucket = byFrame.get(sym.frame);
		if (bucket) bucket.push(sym); else byFrame.set(sym.frame, [sym]);
	}

	const frames = computeFrames(scopes.root, dialect);

	for (const scope of allScopesOf(scopes.root)) {
		if (scope.body.kind !== 'select') continue;
		const frame = frames.get(scope);
		if (frame === undefined) continue; // unreachable: every scope gets a frame
		const bucket = byFrame.get(frame) ?? [];

		// ResolvedSource -> relation-Sym, needed to map a star expansion's `sourceKey`
		// (a plain string) back to the actual Sym object for this scope — sqllens's own
		// walk() emits a scope's own sources' relation Syms in the same order
		// `scope.sources` iterates them (excluding the implicit pipe-stage 'relation'
		// source, which never gets a Sym either).
		const ownSources = [...scope.sources.values()].filter(s => s.kind !== 'relation');
		const relationSyms = bucket.filter(s => RELATION_KINDS.has(s.kind) && s.modifiers.includes('reference'));
		const sourceToSym = new Map<ResolvedSource, Sym>();
		for (let i = 0; i < ownSources.length && i < relationSyms.length; i++) {
			sourceToSym.set(ownSources[i], relationSyms[i]);
		}

		// Synthetic column-reference Syms for a `SELECT *`'s expanded columns.
		// deriveSymbols emits only a single 'star'-modifier Sym for `*` — it never
		// breaks a star down into its resolved output columns — so a CTE consumed
		// only through a downstream `SELECT *` (possibly through a CHAIN of
		// pass-through stars) would otherwise look unreferenced to any consumer
		// walking column Syms (e.g. structure-unused-columns.ts's
		// buildReferencedColumnsMap). Expand via the starExpander, one synthetic Sym
		// per expanded column, `.source` set directly to the star's resolved source —
		// expanding EVERY star (not just the outermost) is what makes a multi-hop
		// chain resolve, since each star in the chain contributes its own link. Spans
		// are deliberately zero-width at the star's own position: `symSpanContains`
		// never matches a zero-width span (column === endColumn is always outside
		// `[column, endColumn)`), so these never affect hover/definition hit-testing —
		// they exist purely for consumers that walk `symbols` looking for a name +
		// resolved source.
		for (const p of scope.body.projections) {
			if (p.expr.kind !== 'star') continue;
			const expanded = starExpander.expandStar(scope, p);
			if (!expanded) continue; // unresolvable star — leave unexpanded
			const anchor = asCst(p.cst).start;
			if (!anchor) continue;
			for (const ec of expanded) {
				const src = ec.table !== undefined ? scope.sources.get(ec.table) : undefined;
				const relSym = src && sourceToSym.get(src);
				if (!relSym) continue; // source with no relation Sym analog (lateral/pivot/…)
				const qualifier = relSym.alias?.name ?? relSym.name;
				const span = { line: anchor.line, column: anchor.column, endLine: anchor.line, endColumn: anchor.column };
				symbols.push({
					kind: 'column',
					modifiers: ['reference'],
					name: `${qualifier}.${normName(ec.name, dialect)}`,
					span,
					frame,
					source: relSym,
				});
			}
		}
	}

	return symbols;
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
