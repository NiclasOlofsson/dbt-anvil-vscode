/**
 * Single import point for sqllens (the native TS SQL parser from the sibling
 * sql-dialect-grammars repo, resolved via the `sqllens` alias in .esbuild.ts /
 * tsconfig paths / vitest.config.ts).
 *
 * Everything in the extension imports sqllens through this module so the alias
 * and the consumed surface stay visible in one place. Add re-exports as the
 * migration consumes more of the API.
 */
import { mapAdapterToDialect } from '../dialect-map';
import { adapterDialect } from 'sqllens';
import type { Dialect } from 'sqllens';

export {
	parse,
	analyze,
	tokenize,
	qualify,
	lineage,
	deriveSymbols,
	resolveScopes,
	dialectSymbols,
	adapterDialect,
	foldIdentifier,
	displayName,
	parseTemplated,
	tokenizeTemplated,
	templateVariants,
	DefaultTemplateProvider,
	Schema,
	CallbackSchema,
	SqlDocument,
	MAIN_FRAME,
} from 'sqllens';

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
	Origin,
	ParseResultIR,
	PartSpan,
	Projection,
	TemplatedParseResult,
	TemplatedParseOptions,
	TemplateVariant,
	TemplateCall,
	TemplateProvider,
	ResolvedExpansion,
	ExpansionShape,
	TagNode,
	MacroCall,
	Qualification,
	QueryBody,
	QueryExpr,
	ResolvedSource,
	Scope,
	ScopeTree,
	Nullability,
	SchemaMapping,
	SchemaProvider,
	SelectExpr,
	SetOpExpr,
	Source,
	Span,
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
 * Close-relative remaps sqllens's own `adapterDialect()` deliberately refuses
 * ("never guesses" — only corpus-gated adapters are mapped upstream). The
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
	return adapterDialect(name) ?? RELATIVE_DIALECTS[name.trim().toLowerCase()];
}
