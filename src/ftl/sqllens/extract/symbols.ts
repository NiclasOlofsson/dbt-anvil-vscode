/**
 * Sym-native symbol extraction (the successor to extract/tokens.ts's Sym → TokenInfo
 * bridge). `deriveSymbols` gives the canonical `Sym[]` for a parse directly from
 * sqllens; this module adds the two correlations no `Sym` field carries yet — a
 * relation's alias, and a column reference's bound source — computed from data
 * already on hand (scope.sources, Qualification.bindingOf) rather than re-deriving
 * sqllens's own span/name logic. Both gaps are filed upstream (vault channel
 * sqllens-anvil.md, 2026-07-06, queued) so this correlation glue is retirable once
 * Sym exposes them directly.
 */
import { deriveSymbols, displayName, MAIN_FRAME } from '../api';
import type { Dialect, Qualification, ResolvedSource, Scope, ScopeTree, SchemaProvider, Sym } from '../api';
import { asCst, columnRefsOf, normName } from './spans';
import type { StarExpander } from './star-expand';

/** The `SymbolKind` values `relationSymbol` (sqllens symbols.ts) produces — everything
 *  a FROM/JOIN source or CTE reference can be, i.e. every kind that can carry an alias. */
const RELATION_KINDS: ReadonlySet<Sym['kind']> = new Set(['table', 'cte', 'subquery', 'lateral']);

export interface SymbolBindings {
	/** A relation-kind reference Sym (table/cte/subquery/lateral) -> its alias Sym, when aliased. */
	aliasOf: Map<Sym, Sym>;
	/** A column-reference Sym -> the relation Sym its qualifier (or bare binding) resolves to. */
	sourceOf: Map<Sym, Sym>;
}

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
 * Derive sqllens's native `Sym[]` for a parse, plus the relation-alias and
 * column-source correlations consumers need on top of it (see module doc).
 * `qualification` is optional — without it `bindings.sourceOf` stays empty (the
 * caller falls back to whatever `.table`/qualifier text a column carries itself).
 * `starExpander` is optional — without it a `SELECT *` stays a single `star`-modifier
 * Sym with no per-column breakdown (see the star-expansion pass below).
 */
export function extractSymbols(
	scopes: ScopeTree,
	dialect: Dialect,
	schema: SchemaProvider,
	qualification?: Qualification,
	starExpander?: StarExpander,
): { symbols: Sym[]; bindings: SymbolBindings } {
	const symbols = deriveSymbols(scopes, schema, { dialect });
	const bindings: SymbolBindings = { aliasOf: new Map(), sourceOf: new Map() };

	// Bucket symbols by frame, preserving emission order within each bucket. Filtering
	// by frame strips out whatever a nested recursion (a subquery's own body, say)
	// pushed in between, leaving each bucket in the same relative order as the
	// scope-tree data it came from — see the module doc for why this is safe.
	const byFrame = new Map<string, Sym[]>();
	for (const sym of symbols) {
		const bucket = byFrame.get(sym.frame);
		if (bucket) bucket.push(sym); else byFrame.set(sym.frame, [sym]);
	}

	const frames = computeFrames(scopes.root, dialect);

	for (const scope of allScopesOf(scopes.root)) {
		const frame = frames.get(scope);
		if (frame === undefined) continue; // unreachable: every scope gets a frame
		const bucket = byFrame.get(frame) ?? [];

		// Relation + alias pairing for this scope's own sources (excluding the implicit
		// pipe-stage 'relation' source — sqllens never emits a Sym for it either), plus
		// ResolvedSource -> relation-Sym for the column-binding pass below. sqllens's own
		// walk() pushes a source's relationSymbol immediately followed by its aliasSymbol
		// (when present), before any recursion into that source's own scope — so within
		// one frame's bucket, "the sym right after a relation-kind reference sym" IS its
		// alias, whenever one exists.
		const ownSources = [...scope.sources.values()].filter(s => s.kind !== 'relation');
		const relationSyms: Sym[] = [];
		for (let i = 0; i < bucket.length; i++) {
			const sym = bucket[i];
			if (!RELATION_KINDS.has(sym.kind) || !sym.modifiers.includes('reference')) continue;
			relationSyms.push(sym);
			const next = bucket[i + 1];
			if (next?.kind === 'alias') bindings.aliasOf.set(sym, next);
		}
		const sourceToSym = new Map<ResolvedSource, Sym>();
		for (let i = 0; i < ownSources.length && i < relationSyms.length; i++) {
			sourceToSym.set(ownSources[i], relationSyms[i]);
		}

		// Column references -> their resolved source's Sym, via the same
		// Qualification.bindingOf mechanism Phase 0 already uses for the retiring bridge
		// (real scope-chain walking, correlation-aware — not a same-scope heuristic).
		// emitColumns pushes exactly one column Sym per `scope.body.columns` entry, in
		// order, so the two arrays line up positionally.
		if (qualification) {
			const refs = columnRefsOf(scope.body);
			const columnSyms = bucket.filter(s => s.kind === 'column' && s.modifiers.includes('reference'));
			for (let i = 0; i < refs.length && i < columnSyms.length; i++) {
				const bound = qualification.bindingOf(scope, refs[i])?.source;
				const relSym = bound && sourceToSym.get(bound);
				if (relSym) bindings.sourceOf.set(columnSyms[i], relSym);
			}
		}

		// Synthetic column-reference Syms for a `SELECT *`'s expanded columns.
		// deriveSymbols emits only a single 'star'-modifier Sym for `*` — it never
		// breaks a star down into its resolved output columns — so a CTE consumed
		// only through a downstream `SELECT *` (possibly through a CHAIN of
		// pass-through stars) would otherwise look unreferenced to any consumer
		// walking column Syms (e.g. structure-unused-columns.ts's
		// buildReferencedColumnsMap). Mirrors extract/tokens.ts's Pass 3 (the
		// retiring bridge's own fix for the same gap): expand via the same
		// starExpander, one synthetic Sym per expanded column, bound via
		// bindings.sourceOf to the star's resolved source — expanding EVERY
		// star (not just the outermost) is what makes a multi-hop chain resolve,
		// since each star in the chain contributes its own link. Spans are
		// deliberately zero-width at the star's own position: `symSpanContains`
		// never matches a zero-width span (column === endColumn is always
		// outside `[column, endColumn)`), so these never affect hover/definition
		// hit-testing — they exist purely for consumers that walk `symbols`
		// looking for a name + resolved source.
		if (starExpander && scope.body.kind === 'select') {
			for (const p of scope.body.projections) {
				if (p.expr.kind !== 'star') continue;
				const expanded = starExpander.expandStar(scope, p);
				if (!expanded) continue; // unresolvable star — leave unexpanded, like the bridge
				const anchor = asCst(p.cst).start;
				if (!anchor) continue;
				for (const ec of expanded) {
					const src = ec.table !== undefined ? scope.sources.get(ec.table) : undefined;
					const relSym = src && sourceToSym.get(src);
					if (!relSym) continue; // source with no relation Sym analog (lateral/pivot/…)
					const qualifier = bindings.aliasOf.get(relSym)?.name ?? relSym.name;
					const span = { line: anchor.line, column: anchor.column, endLine: anchor.line, endColumn: anchor.column };
					const synthetic: Sym = {
						kind: 'column',
						modifiers: ['reference'],
						name: `${qualifier}.${normName(ec.name, dialect)}`,
						span,
						frame,
					};
					symbols.push(synthetic);
					bindings.sourceOf.set(synthetic, relSym);
				}
			}
		}
	}

	return { symbols, bindings };
}
