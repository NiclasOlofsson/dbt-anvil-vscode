/**
 * C4 template-catalog: classify a dbt macro's expansion shape from its source, so
 * `parseTemplated` can fill a statement/CTE-body macro placeholder with a shape-valid
 * fragment (`SELECT 1`) instead of the identifier fill — letting a macro-generated
 * query body (`with c as ({{ playoff_sim(...) }}) {{ playoff_sim_end(...) }}`) parse
 * natively instead of falling back to the blank cascade.
 *
 * Deliberately conservative: a macro whose body is a full query (first significant
 * SQL keyword is WITH or SELECT) classifies as `statement`; a trailing-conjunct macro
 * (body leads with AND/OR — the `generic_is_deleted` family appended after a complete
 * ON/WHERE expression) classifies as `conjunct` (sqllens 012caf8, fills `AND 1=1`);
 * everything else returns `undefined` (the identifier fill).
 *
 * A WHERE-leading body (or a where-mode call of the mode-as-argument family)
 * classifies as `where-clause` (sqllens a269062, fills `WHERE 1=1`) — valid after a
 * bare `FROM t` and after a complete ON predicate alike, the two slots the family
 * actually occupies. It is never `conjunct`: `AND 1=1` breaks the `FROM t` slot.
 *
 * Why `statement` and never `relation`: both fill `SELECT 1`, but `relation` is the shape
 * sqllens flags as a 0->1 regression risk in a bare `from {{ m() }}` slot (fills to the
 * invalid `from SELECT 1`). `statement`'s `SELECT 1` is valid both standalone and inside a
 * `(...)` CTE body, and the corpus's FROM-relations are all `ref()` tags, not bare macros —
 * so never answering `relation` sidesteps that gap by construction.
 *
 * Safety: the lookup is by macro NAME and only consulted for macros that actually appear
 * as `{{ }}` tags, so query-bodied helper/test/adapter macros that never appear in a model
 * body are never classified. The one residual over-reach — a query-bodied macro genuinely
 * called in a predicate slot (`where {{ m() }}`) — is nonsensical dbt and is the slot-blind
 * fit-guard Open Gap sqllens owns; `statement` is safe in every real position (a select-item
 * `SELECT 1` is fit-rejected back to the identifier fill; a `(...)`/statement slot accepts it).
 */
import { DefaultTemplateProvider } from './api';
import type { ExpansionShape, ResolvedRelation, TemplateCall } from './api';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { DescribeCache } from '../../dbt/describe-cache';

type RawNode = ReturnType<ManifestIndexer['getRawNode']>;

/**
 * The warehouse-backed half of the provider (the "relations as we climb" climb,
 * channel: sqllens-anvil 2026-07-10): resolves ref()/source() calls to manifest
 * unique_ids, reads described columns from the indexer's warm column store
 * synchronously, and warms cold lookups through the DescribeCache on prime().
 * `ParseService.EnrichmentConfig` satisfies this structurally.
 */
export interface RelationEnrichment {
	readonly indexer: ManifestIndexer;
	readonly describeCache: DescribeCache;
}

/**
 * Classify a macro's expansion shape from its `macro_sql` source. Returns `statement`
 * for a query-bodied macro (WITH/SELECT-first), `conjunct` for a trailing-conjunct
 * macro (AND/OR-first), `undefined` otherwise (identifier fill).
 *
 * When the call site is supplied, its LITERAL arguments are bound to the macro's
 * declared parameters before classification, so a body that leads with a parameter
 * (`{{ stat }} {{ column_name }}=false`, the mode-as-argument generic_is_deleted
 * signature) classifies by the call's literal mode word: 'and'/'or' → `conjunct`.
 * A 'where' mode still answers `undefined` — see the header on why no shipped
 * shape fits that slot (tripwire tests pin it; channel: sqllens-anvil).
 */
export function classifyMacroShape(macroSql: string | undefined, call?: TemplateCall): ExpansionShape | undefined {
	if (!macroSql) return undefined;
	const body = bindLiteralArgs(macroSql, call)
		// drop the {% macro ... %} opener and {% endmacro %} closer (whitespace-trim variants)
		.replace(/\{%-?\s*macro\b[\s\S]*?%\}/i, '')
		.replace(/\{%-?\s*endmacro\s*-?%\}/i, '')
		// drop remaining jinja tags/expressions/comments and SQL line comments
		.replace(/\{\{[\s\S]*?\}\}/g, ' ')
		.replace(/\{%[\s\S]*?%\}/g, ' ')
		.replace(/\{#[\s\S]*?#\}/g, ' ')
		.replace(/--[^\n]*/g, ' ')
		.trim();
	if (/^(with|select)\b/i.test(body)) return 'statement';
	if (/^(and|or)\b/i.test(body)) return 'conjunct';
	if (/^where\b/i.test(body)) return 'where-clause';
	return undefined;
}

/**
 * Substitute the call's literal arguments into bare `{{ param }}` references.
 * Positional args map to the signature's parameter order; kwargs by name.
 * Non-literal args (`null` — computed expressions the engine refuses to
 * fabricate) bind nothing, leaving the reference for the jinja strip.
 */
function bindLiteralArgs(macroSql: string, call: TemplateCall | undefined): string {
	if (!call) return macroSql;
	const sig = /\{%-?\s*macro\s+[A-Za-z0-9_]+\s*\(([^)]*)\)/i.exec(macroSql);
	if (!sig) return macroSql;
	const params = sig[1].split(',').map(p => p.trim().split('=')[0].trim()).filter(Boolean);
	const bound = new Map<string, string>();
	params.forEach((p, i) => {
		const arg = call.args[i];
		if (typeof arg === 'string') bound.set(p, arg);
	});
	for (const kw of call.kwargs ?? []) {
		if (typeof kw.value === 'string' && params.includes(kw.name)) bound.set(kw.name, kw.value);
	}
	if (bound.size === 0) return macroSql;
	return macroSql.replace(/\{\{-?\s*([A-Za-z0-9_]+)\s*-?\}\}/g, (whole, name: string) => bound.get(name) ?? whole);
}

/** Physical name parts of a manifest node — [database?, schema?, identifier],
 *  where identifier is a source's `identifier`, a model's `alias`, falling back
 *  to `name` (the same derivation DescribeCache uses to qualify a describe). */
function physicalParts(node: RawNode): string[] | undefined {
	if (!node) return undefined;
	const db = 'database' in node ? (node.database as string | undefined) : undefined;
	const schema = 'schema' in node ? (node.schema as string | undefined) : undefined;
	const identifier =
		('identifier' in node ? (node.identifier as string | undefined) : undefined)
		?? ('alias' in node ? (node.alias as string | undefined) : undefined)
		?? ('name' in node ? String(node.name) : undefined);
	if (!identifier) return undefined;
	return [db, schema, identifier].filter((p): p is string => !!p);
}

/**
 * The extension's template provider (sqllens 4e1b18b catalog unification): the
 * shipped `DefaultTemplateProvider` carries the dbt-builtin knowledge (config →
 * "nothing", ref/source relations, env_var strings); this subclass overrides
 * `shapeOf` with the manifest-sourced classifier. `super.shapeOf` runs FIRST so
 * builtins keep their default answers (ship-note contract). Lazy: a macro is
 * classified only when the engine asks about it (i.e. it appears as a tag);
 * package qualifiers are ignored — dbt macro names are unique enough by bare
 * name for the lookup.
 *
 * With `enrichment`, `relationOf` additionally answers the PHYSICAL relation +
 * described columns for ref()/source() calls (the provider contract's
 * "overriding provider answers the physical one"): manifest resolution to a
 * unique_id, columns synchronously from the indexer's warm column store, and a
 * `recordMiss` → `prime()` → DescribeCache warm cycle for cold lookups. A
 * relation answer WITHOUT columns is the contract's not-loaded sentinel — never
 * a fabricated list. `world` stays "open" (the base default): our catalog is
 * partial by construction, so a miss must never diagnose unknown-table.
 */
class AnvilTemplateProvider extends DefaultTemplateProvider {
	constructor(
		private readonly lookupMacroSql: (name: string) => string | undefined,
		private readonly enrichment?: RelationEnrichment,
	) {
		super();
	}

	override shapeOf(call: TemplateCall): ExpansionShape | undefined {
		return super.shapeOf(call) ?? classifyMacroShape(this.lookupMacroSql(call.name), call);
	}

	/** Manifest unique_id for a ref/source call. Arg slots mirror the shipped
	 *  default's: ref's model is the LAST positional (`ref('pkg','model')`) or
	 *  `model=`; source is (source_name, table_name) positionally or by kwarg.
	 *  Computed args (null) resolve nothing — never fabricated. */
	private uidOf(call: TemplateCall): string | undefined {
		if (call.packageParts !== undefined || !this.enrichment) return undefined;
		if (call.name === 'ref') {
			const model = call.kwargs?.find(k => k.name === 'model')?.value
				?? (call.args.length === 1 || call.args.length === 2 ? call.args[call.args.length - 1] : undefined);
			if (typeof model !== 'string') return undefined;
			return this.enrichment.indexer.findModelsByName(model)[0]?.uniqueId;
		}
		if (call.name === 'source') {
			const src = call.kwargs?.find(k => k.name === 'source_name')?.value
				?? (call.args.length === 2 ? call.args[0] : undefined);
			const tbl = call.kwargs?.find(k => k.name === 'table_name')?.value
				?? (call.args.length === 2 ? call.args[1] : undefined);
			if (typeof src !== 'string' || typeof tbl !== 'string') return undefined;
			return this.enrichment.indexer.findSourceByKey(src, tbl)?.uid;
		}
		return undefined;
	}

	override relationOf(call: TemplateCall): ResolvedRelation | undefined {
		const logical = super.relationOf(call);
		const uid = this.uidOf(call);
		if (!uid) return logical;
		const { indexer } = this.enrichment!;
		const nameParts = physicalParts(indexer.getRawNode(uid)) ?? logical?.nameParts;
		if (!nameParts) return logical;
		const cols = indexer.getColumns(uid);
		if (!cols) {
			this.recordMiss(call);
			return { nameParts };
		}
		return { nameParts, columns: cols.map(name => ({ name })) };
	}

	protected override async fetchExpansions(missing: TemplateCall[]): Promise<void> {
		await Promise.all(missing.map(call => {
			const uid = this.uidOf(call);
			return uid ? this.enrichment!.describeCache.columns(uid) : Promise.resolve(undefined);
		}));
	}
}

/**
 * Build a per-document provider from a macro-name -> macro_sql lookup, plus —
 * when the enrichment pair is supplied — warehouse-backed relation answers for
 * ref()/source() (see AnvilTemplateProvider). One instance per parse cycle:
 * misses accumulate across a document's variants and one prime() warms them all.
 */
export function makeTemplateProvider(
	lookup: (name: string) => string | undefined,
	enrichment?: RelationEnrichment,
): DefaultTemplateProvider {
	return new AnvilTemplateProvider(lookup, enrichment);
}
