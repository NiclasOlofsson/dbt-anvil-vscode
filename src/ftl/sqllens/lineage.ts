/**
 * sqllens-backed column lineage — the replacement for the sqlglot `_trace_lineage_v2`
 * + `walkLineageTree` path consumed by the get-column-lineage tool and the lineage
 * graph panel.
 *
 * Contract: `traceColumnLineage()` returns the SAME {@link LineageResult} shape that
 * `walkLineageTree` produces today (dependencies / via_ctes / transformations), so the
 * consumers (`src/tools/get-column-lineage.ts`, `src/views/lineage-graph-provider.ts`)
 * only need an import swap at cutover.
 *
 * Two independent derivations feed the result:
 *
 * 1. **dependencies** — the flat base-table origins of the traced column, from sqllens's
 *    own `lineage()` origin walk (`Lineage.originsOf`). Unions attribute both legs, joins
 *    bind to the right table, `*` expands against the schema — the base-table leaves are
 *    never dropped regardless of how far the hop rendering below goes.
 *
 * 2. **transformations / via_ctes** — rendered from sqllens's per-hop lineage SPINE
 *    (`lineageOf` → `LineageHop`), which rides the same shared binder as (1). This file
 *    no longer contains any name-resolution logic of its own — the former schema-free
 *    resolver clone is gone; only the name-anchored ENTRY (find the root projection for
 *    the traced column) and the RENDERING of the hop DAG into the panel's contract live
 *    here. Spine shape divergences are absorbed in the renderer:
 *      - the spine collapses the outer passthrough → the renderer re-synthesizes the
 *        `outer_query` node from the head hop's context;
 *      - base tables are `terminal` Origins, never hops → rendered as `table:` leaves;
 *      - an `"unresolved"` terminal → the hop is flagged `summarized` (leaves stay
 *        covered by `dependencies`);
 *      - set-op fan-out (one hop per leg) → rendered as ONE `union` transformation with
 *        a branch per leg, in leg order.
 *
 * Expression snippets are sliced from the ORIGINAL sql at the CST span of the producing
 * expression — never reconstructed from the IR.
 */
import { foldIdentifier, lineage as sqllensLineage, lineageOf, parse, resolveScopes, Schema } from 'sqllens';
import type {
	Dialect,
	IdentKind,
	LineageHop,
	Origin,
	Projection,
	ResolvedSource,
	Scope,
	SchemaMapping,
	ScopeTree,
} from 'sqllens';

// ── Result contract (mirrors src/ftl/extractors/lineage-walker.ts) ──────────

export interface ColumnDependency {
	column: string;
	table: string;
	schema?: string;
	database?: string;
	dbt_resource?: string;
	transformations?: Transformation[];
	via_ctes?: string[];
}

export interface TransformationBranch {
	expression?: string;
	sources: string[];
}

export interface Transformation {
	/** Namespaced id: "cte:name", "table:name", or "query" */
	id: string;
	type: 'cte' | 'table' | 'union' | 'outer_query';
	column: string;
	expression?: string;
	sources: string[];
	branches?: TransformationBranch[];
	/**
	 * True when this hop could not be walked structurally (a `*` producer needing a
	 * schema, an ambiguous unqualified ref, or an un-modelled source) and its leaves
	 * are carried by the flat `dependencies` instead of a per-hop expansion. The node
	 * is kept and flagged rather than dropped, so the UI can render it as a
	 * summarized hop. Absent (rather than false) for a fully-walked hop.
	 */
	summarized?: true;
}

export interface LineageResult {
	dependencies: ColumnDependency[];
	via_ctes: string[];
	transformations: Transformation[];
}

/** Maximum length of an inlined expression string (matches the sqlglot path). */
const MAX_EXPR_LEN = 200;

function truncateExpression(expr: string): string {
	return expr.length > MAX_EXPR_LEN ? `${expr.slice(0, MAX_EXPR_LEN - 3)}...` : expr;
}

/**
 * Trace column lineage for a single output column of `sql`.
 *
 * @param sql        the model SQL (compiled / raw — whatever the caller has)
 * @param columnName the output column to trace
 * @param dialect    the sqllens dialect
 * @param schema     optional table→columns catalog (enables `*` expansion + base-table binding)
 */
export function traceColumnLineage(
	sql: string,
	columnName: string,
	dialect: Dialect,
	schema?: SchemaMapping,
): LineageResult {
	const ast = parse(sql, dialect).ast;
	const tree = resolveScopes(ast, dialect);
	const schemaObj = new Schema(schema ?? {});

	const origins = sqllensLineage(tree, schemaObj).originsOf(columnName);
	const dependencies = dependenciesFromOrigins(origins, dialect);

	const renderer = new SpineRenderer(sql, tree, dialect);
	renderer.trace(columnName, schemaObj);

	return {
		dependencies,
		via_ctes: renderer.viaCtes,
		transformations: renderer.transformations(columnName),
	};
}

/** Convert sqllens's flat base-table origins into the consumed `ColumnDependency[]` (deduped). */
function dependenciesFromOrigins(origins: Origin[], dialect: string): ColumnDependency[] {
	const out: ColumnDependency[] = [];
	for (const o of origins) {
		const parts = o.table;
		const table = parts[parts.length - 1] ?? '';
		const dep: ColumnDependency = { column: o.column, table };
		if (parts.length >= 2) dep.schema = parts[parts.length - 2];
		if (parts.length >= 3) dep.database = parts[parts.length - 3];
		if (!out.some(d => foldEq(d.column, dep.column, dialect) && foldEq(d.table, dep.table, dialect, 'table')))
			out.push(dep);
	}
	return out;
}

// ── Scope context: map every reachable scope back to the source that owns it ─

/** What a hop's scope tells the renderer: the transformation id / display name of the source
 *  whose child scope it is, and — for a set-op LEG scope — the id of the union source it
 *  belongs to plus the ordered list of sibling leg scopes. */
interface ScopeCtx {
	id: string;
	name: string;
	isCte: boolean;
	/** Set when this scope is one LEG of a union-bodied source (the id above is the union's). */
	unionLegs?: Scope[];
}

/** Walk the whole scope tree once, mapping child scopes → their owning source's rendering
 *  context. Set-op child scopes additionally map every leaf leg scope to the same union ctx. */
function buildScopeCtx(root: Scope, dialect: string): Map<Scope, ScopeCtx> {
	const map = new Map<Scope, ScopeCtx>();
	const visit = (scope: Scope): void => {
		for (const src of scope.sources.values()) {
			const child = childScopeOf(src);
			if (!child || map.has(child)) continue;
			const ctx: ScopeCtx = { id: sourceId(src), name: derivedName(src), isCte: src.kind === 'cte' };
			map.set(child, ctx);
			if (child.body.kind === 'setop') {
				const legs = unionBranches(child);
				const legCtx: ScopeCtx = { ...ctx, unionLegs: legs };
				for (const leg of legs) if (!map.has(leg)) map.set(leg, legCtx);
			}
			visit(child);
		}
		for (const cte of scope.ctes.values()) visit(cte.scope);
		if (scope.branches) {
			visit(scope.branches.left);
			visit(scope.branches.right);
		}
		for (const child of scope.children) visit(child);
	};
	visit(root);
	void dialect;
	return map;
}

// ── Rendering the spine into the panel contract ─────────────────────────────

class SpineRenderer {
	private readonly transformMap = new Map<string, Transformation>();
	private readonly outerQuerySources = new Set<string>();
	private readonly renderedHops = new Set<LineageHop>();
	private readonly renderedUnions = new Set<string>();
	private ctx!: Map<Scope, ScopeCtx>;
	readonly viaCtes: string[] = [];

	constructor(
		private readonly sql: string,
		private readonly tree: ScopeTree,
		private readonly dialect: string,
	) {}

	/** Name-anchored entry: locate the root producer for `columnName`, get its spine via
	 *  `lineageOf`, and render. Column not projected → empty result (matches sqlglot). */
	trace(columnName: string, schema: Schema): void {
		const root = this.tree.root;
		this.ctx = buildScopeCtx(root, this.dialect);

		// Top-level union: the outer query itself is a set operation — attribute both legs.
		if (root.body.kind === 'setop') {
			this.renderTopLevelUnion(root, columnName, schema);
			return;
		}

		const producer = rootProjection(root, columnName, this.dialect);
		if (!producer) return;

		const head = lineageOf(producer, root, schema);
		// outer_query sources: the source the root read (a collapsed head lives IN that source's
		// scope); an anchored head's expression feeds directly from its children.
		const headCtx = this.ctx.get(head.scope);
		if (headCtx) this.outerQuerySources.add(headCtx.id);
		else for (const id of this.hopSources(head, producer.name ?? columnName)) this.outerQuerySources.add(id);
		this.renderHead(head, root);
	}

	/** Assemble the ordered transformation list (outer_query first, like the sqlglot path). */
	transformations(columnName: string): Transformation[] {
		const list = [...this.transformMap.values()];
		if (this.outerQuerySources.size > 0) {
			list.unshift({
				id: 'query',
				type: 'outer_query',
				column: columnName,
				sources: [...this.outerQuerySources].sort(),
			});
		}
		return list;
	}

	// ── head handling ──────────────────────────────────────────────────────────

	/** The head hop is either (a) a producer inside a source scope (collapsed passthrough /
	 *  computed CTE column) → render it as that source's transformation; or (b) an anchor in
	 *  the ROOT scope (computed root projection, union fork, base-table read) → its own node
	 *  is the outer query itself, so only its children are rendered. An anchored head whose
	 *  flow is entirely unresolved is attributed to the root's LONE source when there is one
	 *  (the only place the flow can have gone — a summarized hop, not a resolution claim). */
	private renderHead(head: LineageHop, root: Scope): void {
		const info = this.ctx.get(head.scope);
		if (info) {
			this.renderHop(head);
			return;
		}
		if (head.terminal === 'unresolved' && head.downstream.length === 0) {
			const lone = loneSourceCtx(root, this.ctx);
			if (lone) {
				if (lone.isCte) this.addVia(lone.name);
				this.ensureTransform(lone.id, 'cte', head.projection?.name ?? '', undefined, [], true);
				this.outerQuerySources.add(lone.id);
			}
			return;
		}
		// Head anchored at the root: render children only (the root IS the outer_query node).
		this.renderChildren(head);
	}

	// ── hop rendering ──────────────────────────────────────────────────────────

	/** Render one producer hop as a transformation under its owning source's id, then recurse. */
	private renderHop(hop: LineageHop): void {
		if (this.renderedHops.has(hop)) return; // DAG: shared hops render once
		this.renderedHops.add(hop);

		const info = this.ctx.get(hop.scope);
		if (!info) {
			// A hop with no owning source (shouldn't occur below the head) — render children.
			this.renderChildren(hop);
			return;
		}
		if (info.unionLegs) {
			// A leg hop reached directly (head collapsed into one leg) — render the whole union.
			this.renderUnion(info, [hop]);
			return;
		}

		if (info.isCte) this.addVia(info.name);
		const column = hop.projection?.name ?? '';
		this.ensureTransform(
			info.id,
			'cte',
			column,
			this.exprSnippet(hop, column),
			this.hopSources(hop, column),
			hop.terminal === 'unresolved' ? true : undefined,
		);
		this.renderChildren(hop);
	}

	/** Render a hop's children: downstream hops (grouping union legs), then table leaves. */
	private renderChildren(hop: LineageHop): void {
		// Group downstream hops that are legs of the same union; render others directly.
		const legGroups = new Map<string, { info: ScopeCtx; hops: LineageHop[] }>();
		for (const d of hop.downstream) {
			const info = this.ctx.get(d.scope);
			if (info?.unionLegs) {
				const g = legGroups.get(info.id) ?? { info, hops: [] };
				g.hops.push(d);
				legGroups.set(info.id, g);
			} else {
				this.renderHop(d);
			}
		}
		for (const g of legGroups.values()) this.renderUnion(g.info, g.hops);

		if (Array.isArray(hop.terminal)) for (const o of hop.terminal) this.renderTableLeaf(o);
	}

	/** One `union` transformation for a set-op source: a branch per leg, in leg order. */
	private renderUnion(info: ScopeCtx, legHops: LineageHop[]): void {
		if (info.isCte) this.addVia(info.name);
		if (this.renderedUnions.has(info.id)) {
			for (const h of legHops) if (!this.renderedHops.has(h)) this.renderLegBody(h);
			return;
		}
		this.renderedUnions.add(info.id);

		const byScope = new Map<Scope, LineageHop>();
		for (const h of legHops) byScope.set(h.scope, h);

		const branches: TransformationBranch[] = [];
		let anySummarized = false;
		for (const leg of info.unionLegs ?? []) {
			const h = byScope.get(leg);
			if (!h) {
				// This leg contributed no hop (a star/bare leg whose ref resolved straight to an
				// origin, or an unresolvable leg) — its leaves live in `dependencies`.
				branches.push({ sources: [] });
				anySummarized = true;
				continue;
			}
			const column = h.projection?.name ?? '';
			const branch: TransformationBranch = { sources: this.hopSources(h, column) };
			const snippet = this.exprSnippet(h, column);
			if (snippet) branch.expression = snippet;
			branches.push(branch);
		}

		const transform: Transformation = {
			id: info.id,
			type: 'union',
			column: legHops[0]?.projection?.name ?? '',
			sources: [],
			branches,
		};
		if (anySummarized) transform.summarized = true;
		this.transformMap.set(info.id, transform);

		for (const h of legHops) this.renderLegBody(h);
	}

	/** Recurse into a leg hop's children without emitting a per-leg transformation (the leg's
	 *  expression/sources live on its union branch). */
	private renderLegBody(hop: LineageHop): void {
		if (this.renderedHops.has(hop)) return;
		this.renderedHops.add(hop);
		this.renderChildren(hop);
	}

	/** Top-level set-op: the panel's `query`-id union node, one branch per leg. */
	private renderTopLevelUnion(root: Scope, columnName: string, schema: Schema): void {
		const legs = unionBranches(root);
		const outputs = root.outputs;
		const idx = outputs !== 'unknown' ? outputs.findIndex(o => foldEq(o, columnName, this.dialect)) : -1;

		const branches: TransformationBranch[] = [];
		let anySummarized = false;
		for (const leg of legs) {
			const producer = legProjection(leg, columnName, idx, this.dialect);
			if (!producer) {
				branches.push({ sources: [] });
				anySummarized = true;
				continue;
			}
			const hop = lineageOf(producer, leg, schema);
			const column = hop.projection?.name ?? columnName;
			const branch: TransformationBranch = { sources: this.hopSources(hop, column) };
			const snippet = this.exprSnippet(hop, column);
			if (snippet) branch.expression = snippet;
			branches.push(branch);
			this.renderedHops.add(hop);
			this.renderChildren(hop);
		}

		const transform: Transformation = { id: 'query', type: 'union', column: columnName, sources: [], branches };
		if (anySummarized) transform.summarized = true;
		this.transformMap.set('query', transform);
	}

	// ── leaves / feeds / snippets ─────────────────────────────────────────────

	private renderTableLeaf(origin: Origin): void {
		const id = `table:${stripQuotes(origin.table[origin.table.length - 1] ?? '')}`;
		this.ensureTransform(id, 'table', origin.column, undefined, []);
	}

	/** The source ids a hop feeds from — its DIRECT reach (downstream hops' owning sources +
	 *  terminal origins' tables), BEFORE the collapsed/descended trail is inserted. Sorted, deduped. */
	private directFeedIds(hop: LineageHop): string[] {
		const ids = new Set<string>();
		for (const d of hop.downstream) {
			const info = this.ctx.get(d.scope);
			if (info) ids.add(info.id);
		}
		if (Array.isArray(hop.terminal)) {
			for (const o of hop.terminal) ids.add(`table:${stripQuotes(o.table[o.table.length - 1] ?? '')}`);
		}
		return [...ids].sort();
	}

	/** The source ids a hop feeds from, WITH its ITEM 12 `via` trail materialized: the ordered
	 *  scopes the walk collapsed (pure renames) or descended (star / bare source) through are
	 *  emitted as chained `cte:` transformation nodes between the hop and its direct reach, and
	 *  the hop's sources become the head of that chain. Without a trail this is `directFeedIds`.
	 *  `column` names the flowing column for the emitted trail nodes (a display detail — the trail
	 *  carries scopes, not per-scope columns; not asserted by the contract). */
	private hopSources(hop: LineageHop, column: string): string[] {
		const direct = this.directFeedIds(hop);
		if (!hop.via?.length) return direct;
		return this.emitViaChain(hop.via, direct, column, hop.terminal === 'unresolved');
	}

	/** Materialize a `via` trail as a chain of `cte:` nodes: the last scope feeds `tailIds`, each
	 *  earlier scope feeds the next. Returns the id(s) the trail's CONSUMER should point at (the
	 *  first scope's id, or `tailIds` when the trail records no source-backed scope). Trail scopes
	 *  are CTE/subquery scopes (each has a `ScopeCtx`); a scope without one is skipped (never a CTE
	 *  the contract needs). `unresolved` flags the whole chain summarized — the flow reached a dead
	 *  end, so every hop it passed through is an incomplete (summarized) node. */
	private emitViaChain(via: readonly Scope[], tailIds: string[], column: string, unresolved: boolean): string[] {
		// via_ctes are recorded consumer-first (the order the flow passes through them).
		for (const scope of via) {
			const info = this.ctx.get(scope);
			if (info?.isCte) this.addVia(info.name);
		}
		// The chain is linked tail-first: the last scope feeds `tailIds`, each earlier feeds the next.
		let nextIds = tailIds;
		for (let i = via.length - 1; i >= 0; i--) {
			const info = this.ctx.get(via[i]);
			if (!info) continue;
			this.ensureTransform(info.id, 'cte', column, undefined, nextIds, unresolved ? true : undefined);
			nextIds = [info.id];
		}
		return nextIds;
	}

	/** The original-sql slice for a hop's expression, unless it is a bare echo of the column. */
	private exprSnippet(hop: LineageHop, column: string): string | undefined {
		const text = sliceCst(this.sql, hop.expr.cst);
		if (text === '' || foldEq(text.trim(), column, this.dialect)) return undefined;
		return truncateExpression(text.trim());
	}

	private ensureTransform(
		id: string,
		type: Transformation['type'],
		column: string,
		expression: string | undefined,
		sources: string[],
		summarized?: true,
	): void {
		const existing = this.transformMap.get(id);
		if (existing) {
			// Enrich a placeholder created earlier (e.g. a table leaf seen via two paths).
			if (expression && !existing.expression) existing.expression = expression;
			if (sources.length > 0) existing.sources = [...new Set([...existing.sources, ...sources])].sort();
			if (summarized && !existing.summarized && existing.type !== 'table') existing.summarized = true;
			return;
		}
		const t: Transformation = { id, type, column, sources };
		if (expression) t.expression = expression;
		if (summarized) t.summarized = true;
		this.transformMap.set(id, t);
	}

	private addVia(name: string): void {
		if (name && !this.viaCtes.includes(name)) this.viaCtes.push(name);
	}
}

/** The rendering context of a scope's SINGLE source, when it has exactly one — the only
 *  place an unresolved flow can have gone (presentation attribution, not resolution). */
function loneSourceCtx(scope: Scope, ctx: Map<Scope, ScopeCtx>): ScopeCtx | undefined {
	if (scope.sources.size !== 1) return undefined;
	const src = [...scope.sources.values()][0];
	const child = childScopeOf(src);
	if (child) return ctx.get(child);
	return { id: sourceId(src), name: derivedName(src), isCte: src.kind === 'cte' };
}

// ── name-anchored entry helpers (contract-side matching, no resolution) ─────

/** The root projection producing `columnName` (by declared name, dialect-true fold). */
function rootProjection(root: Scope, columnName: string, dialect: string): Projection | undefined {
	if (root.body.kind !== 'select') return undefined;
	return root.body.projections.find(
		p => !p.isStar && p.name !== undefined && foldEq(p.name, columnName, dialect),
	);
}

/** The projection producing `columnName` in one top-level union leg: by output position
 *  (positional set-op matching), else by name. */
function legProjection(leg: Scope, columnName: string, idx: number, dialect: string): Projection | undefined {
	if (leg.body.kind !== 'select') return undefined;
	const projs = leg.body.projections;
	if (idx >= 0 && idx < projs.length && !projs[idx].isStar) return projs[idx];
	return projs.find(p => !p.isStar && p.name !== undefined && foldEq(p.name, columnName, dialect));
}

// ── source helpers ──────────────────────────────────────────────────────────

function sourceId(src: ResolvedSource): string {
	switch (src.kind) {
		case 'table':
			return `table:${stripQuotes(src.name[src.name.length - 1] ?? '')}`;
		case 'cte':
			return `cte:${src.ref.def.name}`;
		case 'subquery':
			return `cte:${src.source.alias ?? '_subquery_'}`;
		case 'relation':
			return 'cte:_relation_';
		case 'graphtable':
			return `cte:${src.source.alias ?? src.source.graph.join('.')}`;
		case 'lateral':
			return `table:${src.source.alias ?? '_lateral_'}`;
		case 'pivot':
			return `cte:${src.alias}`;
	}
}

function childScopeOf(src: ResolvedSource): Scope | undefined {
	if (src.kind === 'cte') return src.ref.scope;
	if (src.kind === 'subquery') return src.scope;
	if (src.kind === 'relation') return src.scope;
	if (src.kind === 'graphtable') return src.scope;
	return undefined;
}

function derivedName(src: ResolvedSource): string {
	if (src.kind === 'cte') return src.ref.def.name;
	if (src.kind === 'subquery') return src.source.alias ?? '_subquery_';
	if (src.kind === 'graphtable') return src.source.alias ?? src.source.graph.join('.');
	return '';
}

/** Flatten a set-op scope into its leaf branch scopes (handles nested `a UNION b UNION c`). */
function unionBranches(scope: Scope): Scope[] {
	if (scope.body.kind === 'setop' && scope.branches) {
		return [...unionBranches(scope.branches.left), ...unionBranches(scope.branches.right)];
	}
	return [scope];
}

// ── CST slicing / name normalization ─────────────────────────────────────────

/** Minimal structural view of an antlr `ParserRuleContext` for char-offset slicing. */
interface CstSpan {
	start: { start: number } | null;
	stop: { stop: number } | null;
}

/** Slice the original SQL at a CST node's char span (inclusive stop → exclusive slice end). */
function sliceCst(sql: string, cst: unknown): string {
	const c = cst as CstSpan | null | undefined;
	if (!c || !c.start || !c.stop) return '';
	const start = c.start.start;
	const stop = c.stop.stop;
	if (typeof start !== 'number' || typeof stop !== 'number' || stop < start) return '';
	return sql.slice(start, stop + 1);
}

/** Delimiter strip used only for the DISPLAY id of a table source (`table:<name>`) — never for
 *  comparison. Comparison always goes through {@link foldEq} / {@link foldIdentifier}. */
function stripQuotes(name: string): string {
	if (name.length >= 2) {
		const first = name[0];
		const last = name[name.length - 1];
		if ((first === '`' && last === '`') || (first === '"' && last === '"')) return name.slice(1, -1);
	}
	return name;
}

/** Identifier equality under the dialect's true fold — the single comparison this file uses
 *  (column/alias/output names default to kind "other"; a table name part passes "table"). */
function foldEq(a: string, b: string, dialect: string, kind?: IdentKind): boolean {
	return foldIdentifier(a, dialect, kind) === foldIdentifier(b, dialect, kind);
}
