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
 * 1. **dependencies** — the flat base-table origins of the traced column, taken straight
 *    from sqllens's own `lineage()` origin walk (`Lineage.originsOf`). That walk already
 *    handles every hard case correctly (unions attribute both legs, joins bind to the
 *    right table, `*` expands against the schema), so the base-table leaves are never
 *    dropped regardless of how far the hop walk below can go.
 *
 * 2. **transformations / via_ctes** — the per-hop chain (`b.z ← a.y ← t.x`) that sqllens's
 *    flat `lineage()` collapses. This is reconstructed extension-side from the scope tree,
 *    the same way sqlglot's `to_node` walks: resolve the column from the output scope, find
 *    the projection producing it in the resolved CTE/subquery scope, and recurse into that
 *    projection's column refs. A hop that cannot be walked structurally (a `*` producer that
 *    needs a schema to expand, an ambiguous unqualified ref) is SUMMARIZED — the node is
 *    still emitted and flagged (`summarized: true`) so the UI can render it, and the flat
 *    origins from (1) still cover its leaves. Nothing is silently dropped.
 *
 * Expression snippets are sliced from the ORIGINAL sql at the CST span of the producing
 * expression — never reconstructed from the IR.
 */
import { lineage as sqllensLineage, parse, resolveScopes, Schema } from 'sqllens';
import type {
	Dialect,
	Expr,
	Origin,
	Projection,
	ResolvedSource,
	Scope,
	SchemaMapping,
	SelectExpr,
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
	const dependencies = dependenciesFromOrigins(origins);

	const walker = new HopWalker(sql, tree);
	walker.trace(columnName);

	return {
		dependencies,
		via_ctes: walker.viaCtes,
		transformations: walker.transformations(columnName),
	};
}

/** Convert sqllens's flat base-table origins into the consumed `ColumnDependency[]` (deduped). */
function dependenciesFromOrigins(origins: Origin[]): ColumnDependency[] {
	const out: ColumnDependency[] = [];
	for (const o of origins) {
		const parts = o.table;
		const table = parts[parts.length - 1] ?? '';
		const dep: ColumnDependency = { column: o.column, table };
		if (parts.length >= 2) dep.schema = parts[parts.length - 2];
		if (parts.length >= 3) dep.database = parts[parts.length - 3];
		if (!out.some(d => eq(d.column, dep.column) && eq(d.table, dep.table))) out.push(dep);
	}
	return out;
}

// ── Hop walk over the scope tree ────────────────────────────────────────────

/** A column reference lifted out of an expression tree: its dotted parts + CST span. */
interface ColRef {
	parts: string[];
	cst: unknown;
}

/** A resolved binding: the source a reference comes from and the column name in it. */
interface Binding {
	source: ResolvedSource;
	column: string;
}

class HopWalker {
	private readonly transformMap = new Map<string, Transformation>();
	private readonly outerQuerySources = new Set<string>();
	private readonly seen = new Set<string>();
	private readonly scopeIds = new Map<Scope, number>();
	private scopeCounter = 0;
	readonly viaCtes: string[] = [];

	constructor(
		private readonly sql: string,
		private readonly tree: ScopeTree,
	) {}

	/** Walk the tree from the root output column, populating transforms + via_ctes. */
	trace(columnName: string): void {
		const root = this.tree.root;

		// Top-level union: the outer query itself is a set operation — attribute both legs.
		if (root.body.kind === 'setop') {
			this.handleUnion('query', root, columnName);
			return;
		}

		const producer = findProjection(root, columnName, undefined);
		if (!producer) return; // column not projected — empty result (matches sqlglot)

		const refs = columnRefsIn(producer.expr);
		for (const ref of refs) {
			const b = this.resolveRef(root, ref.parts);
			if (b) this.outerQuerySources.add(sourceId(b.source));
		}
		for (const ref of refs) this.walkRef(root, ref);
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

	/** Resolve one reference in `scope` and record the hop for the source it binds to. */
	private walkRef(scope: Scope, ref: ColRef): void {
		const b = this.resolveRef(scope, ref.parts);
		if (!b) return; // unresolvable ref — its leaves are still carried by `dependencies`
		this.handleBinding(scope, b.source, b.column);
	}

	private handleBinding(scope: Scope, src: ResolvedSource, column: string): void {
		if (src.kind === 'table') {
			this.ensureTransform(sourceId(src), 'table', column, undefined, []);
			return;
		}

		const child = childScopeOf(src);
		if (!child) {
			// lateral / pivot / un-modelled source — summarize (leaves covered by dependencies).
			this.ensureTransform(sourceId(src), 'cte', column, undefined, [], true);
			return;
		}

		const name = derivedName(src);
		const key = `${this.scopeId(child)}::${normalize(column)}`;
		if (this.seen.has(key)) return;
		this.seen.add(key);
		this.addVia(src, name);

		if (child.body.kind === 'setop') {
			this.handleUnion(sourceId(src), child, column);
			return;
		}

		const producer = findProjection(child, column, aliasesOf(src));
		if (!producer) {
			// A `*` / bare-source column: try to resolve it fresh one scope deeper.
			const fresh = this.resolveRef(child, [column]);
			if (fresh) {
				this.ensureTransform(sourceId(src), 'cte', column, undefined, [sourceId(fresh.source)]);
				this.handleBinding(child, fresh.source, fresh.column);
			} else {
				// star-expansion / needs-schema — summarize, don't drop.
				this.ensureTransform(sourceId(src), 'cte', column, undefined, [], true);
			}
			return;
		}

		const refs = columnRefsIn(producer.expr);
		const sources = this.refSources(child, refs);
		this.ensureTransform(sourceId(src), 'cte', column, this.exprSnippet(producer, column), sources);
		for (const ref of refs) this.walkRef(child, ref);
	}

	/** A set-op hop: one branch per union leg, each attributing its own producer + sources. */
	private handleUnion(id: string, scope: Scope, column: string): void {
		const branchScopes = unionBranches(scope);
		const outputs = scope.outputs;
		const idx = outputs !== 'unknown' ? outputs.findIndex(o => eq(o, column)) : -1;
		const branches: TransformationBranch[] = [];
		let anySummarized = false;

		for (const bs of branchScopes) {
			const producer = branchProducer(bs, column, idx);
			if (!producer) {
				branches.push({ sources: [] });
				anySummarized = true;
				continue;
			}
			const refs = columnRefsIn(producer.expr);
			branches.push({ expression: this.exprSnippet(producer, column), sources: this.refSources(bs, refs) });
			for (const ref of refs) this.walkRef(bs, ref);
		}

		const transform: Transformation = { id, type: 'union', column, sources: [], branches };
		if (anySummarized) transform.summarized = true;
		this.transformMap.set(id, transform);
	}

	/** The distinct source ids the given refs bind to within `scope`. */
	private refSources(scope: Scope, refs: ColRef[]): string[] {
		const ids = new Set<string>();
		for (const ref of refs) {
			const b = this.resolveRef(scope, ref.parts);
			if (b) ids.add(sourceId(b.source));
		}
		return [...ids].sort();
	}

	/** The original-sql slice for a producing projection, unless it is a bare echo of the column. */
	private exprSnippet(producer: Projection, column: string): string | undefined {
		const text = sliceCst(this.sql, producer.expr.cst);
		if (text === '' || eq(text.trim(), column)) return undefined;
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

	private addVia(src: ResolvedSource, name: string): void {
		if (src.kind !== 'cte') return; // only real WITH-clause CTEs count as via_ctes
		if (name && !this.viaCtes.includes(name)) this.viaCtes.push(name);
	}

	// ── schema-free-ish name resolution (mirrors scope.ts resolveColumn) ──────

	/**
	 * Bind a reference's parts to a visible source. Qualified refs (`t.c`) bind by
	 * qualifier alone (no schema needed). Unqualified refs bind to the single source
	 * whose known outputs include the column; failing that, to the one bare table in
	 * scope (a base-column leaf). Returns undefined when genuinely ambiguous/unknown —
	 * the caller then relies on the flat `dependencies` for those leaves.
	 */
	private resolveRef(scope: Scope, parts: string[]): Binding | undefined {
		const split = splitRef(parts, key => hasVisibleSource(scope, key));

		if (split.qualifier !== undefined) {
			for (let s: Scope | undefined = scope; s; s = s.parent) {
				const source = s.sources.get(split.qualifier);
				if (source) return { source, column: split.column };
			}
			return undefined;
		}

		// Unqualified: resolve against each scope's sources, walking outward for correlation.
		// A `needs-schema` (a source with unknown columns might have it) STOPS the walk at that
		// scope — the column belongs to a relation here, not a correlated outer one; if that
		// scope has a single source, bind to it (the common `SELECT x FROM t` / passthrough leaf).
		for (let s: Scope | undefined = scope; s; s = s.parent) {
			const r = resolveByColumnName(s, split.column);
			if (r === 'ambiguous') return undefined;
			if (r === 'needs-schema') {
				const lone = loneSource(s);
				return lone ? { source: lone, column: split.column } : undefined;
			}
			if (r) return { source: r, column: split.column };
			// r === undefined (no source here could have it) → try the enclosing scope.
		}
		return undefined;
	}

	private scopeId(scope: Scope): number {
		let id = this.scopeIds.get(scope);
		if (id === undefined) {
			id = this.scopeCounter++;
			this.scopeIds.set(scope, id);
		}
		return id;
	}
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

function aliasesOf(src: ResolvedSource): string[] | undefined {
	if (src.kind === 'cte') return src.ref.def.columnAliases;
	if (src.kind === 'subquery') return src.source.columnAliases;
	return undefined;
}

/** A resolved source's known output columns, or "unknown" when a schema is required. */
function sourceOutputs(src: ResolvedSource): string[] | 'unknown' {
	if (src.kind === 'table') return src.source.columnAliases ?? 'unknown';
	if (src.kind === 'cte') return src.ref.scope.outputs;
	if (src.kind === 'subquery') return src.scope.outputs;
	if (src.kind === 'relation') return src.scope.outputs;
	if (src.kind === 'graphtable') return src.scope.outputs;
	if (src.kind === 'lateral') return src.source.columns;
	return 'unknown'; // pivot — needs schema
}

/** True if `key` names a source in this scope or any enclosing one (for correlation). */
function hasVisibleSource(scope: Scope, key: string): boolean {
	for (let s: Scope | undefined = scope; s; s = s.parent) if (s.sources.has(key)) return true;
	return false;
}

/**
 * Resolve an unqualified name against a single scope's sources (schema-free), mirroring
 * scope.ts `resolveByColumnName`: a single known-column match binds; several is ambiguous;
 * none-known-but-some-unknown is `needs-schema` (a bare table might carry it); truly none
 * is `undefined` (try an enclosing scope for correlation).
 */
function resolveByColumnName(scope: Scope, column: string): ResolvedSource | 'ambiguous' | 'needs-schema' | undefined {
	const n = normalize(column);
	const matches: ResolvedSource[] = [];
	let anyUnknown = false;
	for (const src of scope.sources.values()) {
		const cols = sourceOutputs(src);
		if (cols === 'unknown') anyUnknown = true;
		else if (cols.some(c => normalize(c) === n)) matches.push(src);
	}
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) return 'ambiguous';
	return anyUnknown ? 'needs-schema' : undefined;
}

/** The single source of a scope (any kind), if there is exactly one — else undefined.
 *  A lone source is where an otherwise-unresolvable column must come from (a base table,
 *  or a `SELECT *` passthrough CTE the column flows straight through). */
function loneSource(scope: Scope): ResolvedSource | undefined {
	if (scope.sources.size !== 1) return undefined;
	return [...scope.sources.values()][0];
}

/** Flatten a set-op scope into its leaf branch scopes (handles nested `a UNION b UNION c`). */
function unionBranches(scope: Scope): Scope[] {
	if (scope.body.kind === 'setop' && scope.branches) {
		return [...unionBranches(scope.branches.left), ...unionBranches(scope.branches.right)];
	}
	return [scope];
}

/** The projection producing `column` in a union-branch scope: by output position, else by name. */
function branchProducer(scope: Scope, column: string, idx: number): Projection | undefined {
	if (scope.body.kind !== 'select') return undefined;
	const projs = scope.body.projections;
	if (idx >= 0 && idx < projs.length && !projs[idx].isStar) return projs[idx];
	return findProjection(scope, column, undefined);
}

/** The projection producing `column` in a select scope (by declared alias order, else by name). */
function findProjection(scope: Scope, column: string, aliases: string[] | undefined): Projection | undefined {
	if (scope.body.kind !== 'select') return undefined;
	const projs = (scope.body as SelectExpr).projections;
	if (aliases) {
		const i = aliases.findIndex(a => eq(a, column));
		return i >= 0 ? projs[i] : undefined;
	}
	return projs.find(p => !p.isStar && p.name !== undefined && eq(p.name, column));
}

// ── reference splitting (mirrors scope.ts splitColumnRef) ────────────────────

interface SplitRef {
	qualifier?: string;
	column: string;
}

function splitRef(parts: string[], isSource: (key: string) => boolean): SplitRef {
	if (parts.length >= 3 && isSource(normalize(parts[1]))) {
		return { qualifier: normalize(parts[1]), column: parts[2] };
	}
	if (parts.length >= 2 && isSource(normalize(parts[0]))) {
		return { qualifier: normalize(parts[0]), column: parts[1] };
	}
	return { column: parts[0] ?? '' };
}

// ── expression traversal ────────────────────────────────────────────────────

/** Every column reference directly within an expression (not descending into subqueries). */
function columnRefsIn(expr: Expr): ColRef[] {
	const out: ColRef[] = [];
	const visit = (e: Expr): void => {
		switch (e.kind) {
			case 'column':
				out.push({ parts: e.parts, cst: e.cst });
				break;
			case 'binary':
				visit(e.left);
				visit(e.right);
				break;
			case 'unary':
				visit(e.operand);
				break;
			case 'cast':
				visit(e.expr);
				break;
			case 'function':
				e.args.forEach(visit);
				e.window?.partitionBy.forEach(visit);
				e.window?.orderBy.forEach(visit);
				break;
			case 'case':
				e.whens.forEach(w => {
					visit(w.when);
					visit(w.then);
				});
				if (e.elseExpr) visit(e.elseExpr);
				break;
			case 'predicate':
				visit(e.operand);
				e.args.forEach(visit);
				break;
			case 'subscript':
				visit(e.base);
				visit(e.index);
				break;
			case 'lambda':
				visit(e.body);
				break;
			case 'with':
				e.bindings.forEach(b => visit(b.value));
				visit(e.result);
				break;
			// literal / star / subquery / exists / other → no directly-owned column refs
		}
	};
	visit(expr);
	return out;
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

function stripQuotes(name: string): string {
	if (name.length >= 2) {
		const first = name[0];
		const last = name[name.length - 1];
		if ((first === '`' && last === '`') || (first === '"' && last === '"')) return name.slice(1, -1);
	}
	return name;
}

function normalize(name: string): string {
	return stripQuotes(name).toLowerCase();
}

function eq(a: string, b: string): boolean {
	return normalize(a) === normalize(b);
}
