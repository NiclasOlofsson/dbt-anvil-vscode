/**
 * Single import point for sqllens (the native TS SQL parser from the sibling
 * sql-dialect-grammars repo, resolved via the `sqllens` alias in .esbuild.ts /
 * tsconfig paths / vitest.config.ts).
 *
 * Everything in the extension imports sqllens through this module so the alias
 * and the consumed surface stay visible in one place. Add re-exports as the
 * migration consumes more of the API.
 */
export {
	parse,
	analyze,
	tokenize,
	qualify,
	lineage,
	deriveSymbols,
	Schema,
	SqlDocument,
	MAIN_FRAME,
} from 'sqllens';

export type {
	Analysis,
	ColumnLineage,
	CteDef,
	Dialect,
	Expr,
	Origin,
	ParseResultIR,
	Projection,
	QueryBody,
	QueryExpr,
	SchemaMapping,
	SelectExpr,
	SetOpExpr,
	Source,
	Span,
	Sym,
	SymbolKind,
	SymbolModifier,
	SyntaxDiagnostic,
	Token,
	TokenRole,
} from 'sqllens';

/** The five dialects sqllens implements, as the extension routes them. */
export const SQLLENS_DIALECTS = ['databricks', 'tsql', 'snowflake', 'bigquery', 'redshift'] as const;
