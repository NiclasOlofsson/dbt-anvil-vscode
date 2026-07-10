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
	DefaultTemplateProvider,
	Schema,
	CallbackSchema,
	SqlDocument,
	MAIN_FRAME,
} from 'sqllens';

export {
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
	Analysis,
	ColumnLineage,
	ColumnRef,
	CteDef,
	CteRef,
	Dialect,
	DialectSymbols,
	Diagnostic,
	Expr,
	IdentKind,
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
 * The ONE dialect mapping the extension owns: dbt ADAPTER constants → sqllens
 * Dialect constants, for the adapters sqllens's own `resolveDialect()`
 * deliberately refuses ("never guesses" — only corpus-gated engines are mapped
 * upstream). Two kinds of entry, same shape: renames (`postgresql` is dbt's
 * spelling of postgres) and close relatives (hive's SQL surface is near-enough
 * Spark SQL that a best-effort parse beats dropping intelligence). Everything
 * else dialect-shaped lives in sqllens; new dialects route through with zero
 * changes here unless their dbt adapter name differs from the dialect name.
 */
const DBT_ADAPTER_DIALECTS: Record<string, Dialect> = {
	postgresql: 'postgres',
	hive: 'databricks',
	spark2: 'databricks',
	fabricspark: 'databricks',
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
