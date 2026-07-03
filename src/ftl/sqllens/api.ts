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
	Schema,
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
	Join,
	JoinKind,
	Origin,
	ParseResultIR,
	PartSpan,
	Projection,
	QueryBody,
	QueryExpr,
	ResolvedSource,
	Scope,
	ScopeTree,
	SchemaMapping,
	SelectExpr,
	SetOpExpr,
	Source,
	Span,
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
 * Map a canonical sqlglot dialect name (what `mapAdapterToDialect` returns) to
 * one of the eight dialects sqllens actually implements. sqllens's `databricks`
 * grammar is Spark-based, so Spark/Hive family adapters route there; Athena is
 * Presto/Trino. Anything unrecognised falls back to `databricks` (the widest,
 * most permissive grammar) so the parser never throws on an unknown adapter.
 */
const SQLLENS_BY_SQLGLOT: Record<string, Dialect> = {
	databricks: 'databricks',
	spark: 'databricks',
	spark2: 'databricks',
	hive: 'databricks',
	tsql: 'tsql',
	fabric: 'tsql',
	snowflake: 'snowflake',
	bigquery: 'bigquery',
	redshift: 'redshift',
	postgres: 'postgres',
	materialize: 'postgres',
	risingwave: 'postgres',
	duckdb: 'duckdb',
	trino: 'trino',
	athena: 'trino',
	presto: 'trino',
};

/** Resolve a dbt adapter type to the sqllens `Dialect` gate value. */
export function toSqllensDialect(adapterType: string | undefined): Dialect {
	const sqlglot = mapAdapterToDialect(adapterType);
	return (sqlglot && SQLLENS_BY_SQLGLOT[sqlglot]) || 'databricks';
}
