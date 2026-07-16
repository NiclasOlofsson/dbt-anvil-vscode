/**
 * Single import point for sqllens (the native TS SQL parser from the sibling
 * sql-dialect-grammars repo, resolved via the `sqllens` and `sqllens/minijinja`
 * aliases in .esbuild.ts / tsconfig(.test) paths / vitest.config.ts).
 *
 * Everything in the extension imports sqllens through this module so the alias
 * and the consumed surface stay visible in one place. Add re-exports as the
 * migration consumes more of the API.
 *
 * Two barrels since sqllens 0d51d95 (the engine-subpath cut, absorbed here as
 * the agreed clean cut): the jinja entry points (parseTemplated /
 * tokenizeTemplated / templateVariants and the TagNode/MacroCall tag-AST types)
 * live on `sqllens/minijinja`; everything engine-neutral — including the
 * TemplateEngine result/options contract and the TemplateProvider seam — stays
 * on the main barrel.
 */
import { resolveDialect } from 'sqllens';
import type { Dialect } from 'sqllens';

export {
	parse,
	analyze,
	tokenize,
	qualify,
	lineage,
	lineageOf,
	deriveSymbols,
	referencesAt,
	resolveScopes,
	dialectSymbols,
	resolveDialect,
	foldIdentifier,
	symbolAt,
	displayName,
	completeAt,
	signatureAt,
	jinjaSlotAt,
	DefaultTemplateProvider,
	DbtTemplateProvider,
	Schema,
	CallbackSchema,
	SqlDocument,
	MAIN_FRAME,
} from 'sqllens';

export {
	minijinja,
	parseTemplated,
	tokenizeTemplated,
	templateVariants,
} from 'sqllens/minijinja';

export type {
	TagNode,
	MacroCall,
	TemplateVariant,
} from 'sqllens/minijinja';

export type {
	DocumentVariant,
	UnionCte,
} from 'sqllens';

export type {
	Analysis,
	ColumnLineage,
	ColumnRef,
	Completion,
	CteDef,
	CteRef,
	Dialect,
	DialectSymbols,
	Diagnostic,
	Expr,
	IdentKind,
	JinjaSlot,
	SignatureHelpInfo,
	TemplateCandidate,
	Join,
	JoinKind,
	LineageHop,
	Origin,
	ParseResultIR,
	PartSpan,
	Projection,
	TemplatedParseResult,
	TemplatedParseOptions,
	TemplateCall,
	TemplateProvider,
	ResolvedExpansion,
	ResolvedRelation,
	ExpansionShape,
	Qualification,
	QueryBody,
	QueryExpr,
	ResolvedSource,
	Scope,
	ScopeTree,
	Nullability,
	Occurrence,
	Occurrences,
	SchemaMapping,
	SchemaProvider,
	SelectExpr,
	SetOpExpr,
	Source,
	Span,
	StarExpansion,
	StatementCell,
	StatementCellSpan,
	TableResolver,
	SubquerySource,
	Sym,
	SymbolKind,
	SymbolModifier,
	SyntaxDiagnostic,
	TableSource,
	Token,
	TokenRole,
} from 'sqllens';

/**
 * TOMBSTONE-BOUND: dbt adapter constants → sqllens Dialect constants, only for
 * entries whose upstream admission is pending (channel: sqllens-anvil
 * 2026-07-10 18:17 — materialize/risingwave/postgresql requested into
 * DERIVED_DIALECTS; delete each entry as upstream admits or refuses it; the
 * table dies empty). Entries whose target equals the fallback are deliberately
 * absent — the fallback already routes them. The only durable dialect
 * knowledge the extension keeps is the fallback constant in
 * `toSqllensDialect`: parse unknown adapters as databricks rather than
 * dropping SQL intelligence — a consumer UX policy, not engine knowledge.
 */
const DBT_ADAPTER_DIALECTS: Record<string, Dialect> = {
	materialize: 'postgres',
	risingwave: 'postgres',
};

/**
 * Resolve a dbt adapter type to the sqllens `Dialect` gate value: sqllens's
 * own engine map first, then the dbt-adapter mapping above, finally
 * `databricks` — the fallback keeps the parse paths total; the ParseService
 * wiring decides whether an unmapped adapter should instead degrade to no SQL
 * intelligence.
 */
export function toSqllensDialect(adapterType: string | undefined): Dialect {
	if (!adapterType) return 'databricks';
	return resolveDialect(adapterType)
		?? DBT_ADAPTER_DIALECTS[adapterType.trim().toLowerCase()]
		?? 'databricks';
}
