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
import { mapAdapterToDialect } from '../dialect-map';
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

/** The eight dialects sqllens implements, as the extension routes them. */
export const SQLLENS_DIALECTS = [
	'databricks', 'tsql', 'snowflake', 'bigquery', 'redshift', 'postgres', 'duckdb', 'trino',
] as const;

/**
 * Close-relative remaps sqllens's own `resolveDialect()` deliberately refuses
 * ("never guesses" — only corpus-gated engines are mapped upstream; the dbt
 * ADAPTER vocabulary is ours to own since sqllens fc7ec4f de-dbt'd its map). The
 * extension accepts a best-effort parse for near-identical SQL surfaces rather
 * than dropping intelligence entirely.
 */
const RELATIVE_DIALECTS: Record<string, Dialect> = {
	hive: 'databricks',
	spark2: 'databricks',
	fabricspark: 'databricks',
	materialize: 'postgres',
	risingwave: 'postgres',
	postgresql: 'postgres',
};

/**
 * Resolve a dbt adapter type to the sqllens `Dialect` gate value: sqllens's
 * own adapter map first, then the relatives layer (accepting alternate
 * dialect names as input too), finally `databricks` — the fallback keeps the
 * shadow/test paths total; the ParseService wiring decides whether an unmapped
 * adapter should instead degrade to no SQL intelligence.
 */
export function toSqllensDialect(adapterType: string | undefined): Dialect {
	if (!adapterType) return 'databricks';
	const direct = adapterDialectOrRelative(adapterType);
	if (direct) return direct;
	const mapped = mapAdapterToDialect(adapterType);
	return (mapped && adapterDialectOrRelative(mapped)) || 'databricks';
}

function adapterDialectOrRelative(name: string): Dialect | undefined {
	return resolveDialect(name) ?? RELATIVE_DIALECTS[name.trim().toLowerCase()];
}
