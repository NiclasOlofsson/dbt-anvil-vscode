/**
 * C4 template-catalog: the expansion shapes of a dbt macro call, so `parseTemplated`
 * can fill a macro placeholder with a shape-valid fragment (`SELECT 1`, `AND 1=1`,
 * `WHERE 1=1`, ...) instead of the identifier fill — letting a macro-generated query
 * body (`with c as ({{ playoff_sim(...) }}) {{ playoff_sim_end(...) }}`) or a trailing
 * predicate macro parse natively instead of falling back to the blank cascade.
 *
 * The shapes come from sqllens (1.9.0): every `{% macro %}` body is read as a fragment
 * and `MacroShape.shapes` lists what it can be, most specific first, empty when nothing
 * can be established (never-wrong). `shapesForCall` resolves the mode-as-argument
 * family (`{{ stat }} {{ col }} = false`, called with `'and'` / `'where'`) from the
 * call's literal argument or the parameter's default. The manifest index reads and
 * caches the shape per macro (`ManifestIndexer.macroShape`); this provider only looks
 * it up by the call's bare name, and only for macros that actually appear as `{{ }}`
 * tags.
 */
import { DbtTemplateProvider, DefaultTemplateProvider, shapesForCall } from './api';
import type { ExpansionShape, MacroShape, ResolvedRelation, TemplateCall, TemplateCandidate } from './api';
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
 * The extension's template provider. Since sqllens 1.2.0 the dbt-builtin knowledge
 * (config → "nothing", ref/source relations, env_var strings) lives in
 * `DbtTemplateProvider` (moved out of the neutral `DefaultTemplateProvider`), so this
 * subclass extends THAT and overrides `shapeOf` with the manifest-sourced shapes.
 * `super.shapeOf` runs FIRST so builtins keep their default answers (ship-note
 * contract). Lazy: a macro is looked up only when the engine asks about it (i.e. it
 * appears as a tag); package qualifiers are ignored — dbt macro names are unique
 * enough by bare name for the lookup.
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
class AnvilTemplateProvider extends DbtTemplateProvider {
	constructor(
		private readonly lookupMacro: (name: string) => MacroShape | undefined,
		private readonly enrichment?: RelationEnrichment,
	) {
		super();
	}

	/** An empty answer from sqllens means "nothing established": return undefined so the
	 *  engine keeps its zero-knowledge floor instead of an empty list. */
	override shapeOf(call: TemplateCall): ExpansionShape | readonly ExpansionShape[] | undefined {
		const builtin = super.shapeOf(call);
		if (builtin !== undefined) return builtin;
		const macro = this.lookupMacro(call.name);
		if (!macro) return undefined;
		const shapes = shapesForCall(macro, call);
		return shapes.length > 0 ? shapes : undefined;
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

	/**
	 * Completion candidates for a jinja call slot — the REQ2 seam. sqllens detects WHICH slot
	 * the caret is in (`jinjaSlotAt`) and hands us the whole parsed call; the dbt MEANING of
	 * that slot is ours, and so is the catalog that fills it. Nothing here parses: we answer
	 * names, sqllens placed the caret.
	 *
	 *   callee slot (argIndex -1)  → the callees we know: dbt's `ref`/`source` + manifest macros
	 *   ref(…)                     → model names (package names in the 2-arg form's slot 0)
	 *   source(…) arg 0            → source names
	 *   source(…) arg 1            → the tables OF the source named in arg 0
	 *
	 * Taking the whole `TemplateCall` (sqllens 1.4.0, issue #37) is what makes the last one
	 * possible: an arg's candidates can depend on its siblings, and `call.args` carries them
	 * (literal string per arg, `null` when computed). Without a manifest we know no names and
	 * answer none — never a fabricated list.
	 */
	override templateCandidates(call: TemplateCall, argIndex: number): TemplateCandidate[] {
		const index = this.enrichment?.indexer.index;
		if (!index) return [];

		const packageName = call.packageParts?.join('.');

		// The caret is still in the callee identifier (`{{ re|`, `{{ dbt_utils.st|`).
		if (argIndex === -1) {
			const out: TemplateCandidate[] = [];
			// `ref`/`source` are dbt builtins, not manifest macros — they exist in no map we
			// hold, so they must be named here or they can never be completed at all.
			if (packageName === undefined) {
				out.push({ label: 'ref', detail: 'dbt model reference' });
				out.push({ label: 'source', detail: 'dbt source reference' });
			}
			for (const macro of index.macros.values()) {
				if (packageName !== undefined && macro.packageName !== packageName) continue;
				out.push({ label: macro.name, detail: macro.packageName });
			}
			return out;
		}

		if (call.name === 'ref') {
			// dbt: the model is the LAST arg — `ref('model')` / `ref('pkg','model')`. The whole
			// call gives us the arity, so slot 0 of the 2-arg form is the PACKAGE, not a model.
			if (call.args.length >= 2 && argIndex === 0) {
				const packages = new Set([...index.models.values()].map(m => m.packageName));
				return [...packages].sort().map(label => ({ label, detail: 'dbt package' }));
			}
			return [...index.models.values()].map(m => ({
				label: m.name,
				detail: `${m.materialisation} — ${m.packageName}`,
			}));
		}

		if (call.name === 'source') {
			if (argIndex === 0) {
				const names = new Set([...index.sources.values()].map(s => s.sourceName));
				return [...names].sort().map(label => ({ label, detail: 'dbt source' }));
			}
			if (argIndex === 1) {
				// `source('raw', 'ord|')` — narrow to raw's tables via the sibling arg.
				const sourceName = call.args[0];
				if (typeof sourceName === 'string') {
					return [...index.sources.values()]
						.filter(s => s.sourceName === sourceName)
						.map(s => ({ label: s.name, detail: s.schema ?? sourceName }));
				}
				// arg 0 is computed (`source(var('s'), …)`) — no source to narrow by, so name
				// every table with its owning source(s) rather than guess one.
				const bySource = new Map<string, string[]>();
				for (const s of index.sources.values()) {
					if (!bySource.has(s.name)) bySource.set(s.name, []);
					bySource.get(s.name)!.push(s.sourceName);
				}
				return [...bySource].map(([label, owners]) => ({ label, detail: owners.join(', ') }));
			}
		}

		// A user macro's arguments: we know its parameter names, not their legal values.
		return [];
	}

	/**
	 * Bare relation-name candidates for a FROM/JOIN slot (the SchemaProvider seam sqllens's
	 * completeAt reads for `table`-kind candidates). dbt model names, deduped by name — a
	 * same-named model in two packages is one bare candidate here, since a bare FROM name
	 * carries no package. In-scope CTE names are NOT ours: sqllens emits those itself (kind
	 * "cte") from the query's own scope. Without a manifest we know no names.
	 */
	override tables(): string[] {
		const index = this.enrichment?.indexer.index;
		if (!index) return [];
		return [...new Set([...index.models.values()].map(m => m.name))];
	}

	/**
	 * The immediate children of a dotted relation path (the #38 SchemaProvider seam): the NEXT
	 * segment after a qualifier dot, powering qualified-path completion off the manifest catalog.
	 * `catalog.` answers the schemas inside it (kind "namespace"); `catalog.schema.` (or a bare
	 * `schema.`) answers its relations (kind "table"). Replaces our FROM-line FQN regex. Matched
	 * case-insensitively against the physical database/schema the manifest records, over models
	 * and sources alike.
	 */
	childrenOf(prefixParts: string[]): { name: string; kind: 'namespace' | 'table' }[] {
		const index = this.enrichment?.indexer.index;
		if (!index || prefixParts.length === 0) return [];
		const parts = prefixParts.map(p => p.toLowerCase());
		const models = [...index.models.values()];
		const sources = [...index.sources.values()];
		const out: { name: string; kind: 'namespace' | 'table' }[] = [];
		const seen = new Set<string>();
		const push = (name: string | undefined, kind: 'namespace' | 'table'): void => {
			if (!name) return;
			const key = `${kind}:${name.toLowerCase()}`;
			if (!seen.has(key)) { seen.add(key); out.push({ name, kind }); }
		};

		if (parts.length === 1) {
			const seg = parts[0];
			// `<database>.` -> the schemas inside it.
			for (const m of models) if (m.database?.toLowerCase() === seg) push(m.schema, 'namespace');
			for (const s of sources) if (s.database?.toLowerCase() === seg) push(s.schema, 'namespace');
			// `<schema>.` -> the relations inside it (a 2-part schema.table path).
			for (const m of models) if (m.schema?.toLowerCase() === seg) push(m.name, 'table');
			for (const s of sources) if (s.schema?.toLowerCase() === seg) push(s.name, 'table');
		} else if (parts.length === 2) {
			const [db, schema] = parts;
			for (const m of models) if (m.database?.toLowerCase() === db && m.schema?.toLowerCase() === schema) push(m.name, 'table');
			for (const s of sources) if (s.database?.toLowerCase() === db && s.schema?.toLowerCase() === schema) push(s.name, 'table');
		}
		return out;
	}

	protected override async fetchExpansions(missing: TemplateCall[]): Promise<void> {
		await Promise.all(missing.map(call => {
			const uid = this.uidOf(call);
			return uid ? this.enrichment!.describeCache.columns(uid) : Promise.resolve(undefined);
		}));
	}
}

/**
 * Build a per-document provider from a macro-name -> MacroShape lookup
 * (`ManifestIndexer.macroShape`), plus — when the enrichment pair is supplied —
 * warehouse-backed relation answers for ref()/source() (see AnvilTemplateProvider).
 * One instance per parse cycle: misses accumulate across a document's variants and
 * one prime() warms them all.
 */
export function makeTemplateProvider(
	lookup: (name: string) => MacroShape | undefined,
	enrichment?: RelationEnrichment,
): DefaultTemplateProvider {
	return new AnvilTemplateProvider(lookup, enrichment);
}

/**
 * The zero-configuration dbt default. Since sqllens 1.2.0 the neutral
 * `DefaultTemplateProvider` carries NO dbt vocabulary, so a parse built without a
 * provider resolves `ref`/`source` to nothing and the relation binds to the raw
 * placeholder fill (`j0jjjj…`) instead of the model name. EVERY parse path that has no
 * richer (manifest-backed) provider must pass this one: it is sqllens's shipped dbt
 * overlay — ref → the logical model name, source → [source, table], env_var → string,
 * config/docs/… → no output.
 *
 * Safe to share as a singleton: static famous-macro knowledge only, no state, nothing
 * closed over per document (the same rationale as sqllens's own `OPEN_PROVIDER`).
 */
export const DBT_PROVIDER: DefaultTemplateProvider = new DbtTemplateProvider();
