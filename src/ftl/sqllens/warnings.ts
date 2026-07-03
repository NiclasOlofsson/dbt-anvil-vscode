/**
 * sqllens-backed parse/scope warnings — the replacement for the sqlglot
 * `_collect_parse_errors` + scope-warning path whose output the extension consumes
 * as {@link SqlglotWarning} (`src/services/parse-service.ts`).
 *
 * Two sqllens diagnostic sources map onto the two warning types:
 *
 * - **syntax_error** ← `parse().diagnostics` (`SyntaxDiagnostic`): outright parse failures.
 * - **scope_warning** ← `qualify().diagnostics` (`Diagnostic`): schema-fed resolution
 *   problems (unknown table/column/field, ambiguous column). sqlglot's original
 *   "cannot analyse a CTE scope" failure has no direct sqllens analog — `resolveScopes`
 *   is total — so the schema-fed qualify diagnostics stand in for it, which is the
 *   closest "SQL parsed OK but the analyzer objects" signal the new pipeline produces.
 *
 * Position conversions reproduce the legacy `_collect_parse_errors` exactly. sqllens
 * positions are ANTLR-native: `line` 1-based, `column`/`endColumn` 0-based (end one past
 * the last char). The extension's `SqlglotWarning` wants 0-based `line`, 0-based start
 * `col`, and 0-based exclusive `endCol`.
 */
import { parse, qualify, Schema } from 'sqllens';
import type { Diagnostic, Dialect, SchemaMapping, SyntaxDiagnostic } from 'sqllens';

/**
 * A structural issue detected during parsing / analysis (mirrors the extension's
 * `SqlglotWarning`, `src/services/parse-service.ts`).
 *
 * - `syntax_error`: a parse failure; `line`/`col`/`endCol` point at the bad token.
 * - `scope_warning`: SQL parsed OK but the schema-fed analysis objects (unknown /
 *   ambiguous column, unknown table/field).
 */
export interface SqlglotWarning {
	type: 'scope_warning' | 'syntax_error';
	message: string;
	cteName?: string;
	/** 0-based line number to point the diagnostic at */
	line?: number;
	/** 0-based start column of the offending token */
	col?: number;
	/** 0-based exclusive end column of the offending token */
	endCol?: number;
}

/**
 * Map sqllens syntax diagnostics to `syntax_error` warnings.
 *
 * sqllens: `line` 1-based, `column` 0-based start, `length` = offending token length.
 * Legacy parity: `line - 1` (0-based), `col = column` (0-based start), and
 * `endCol = column + length` (0-based exclusive end — the same quantity the sqlglot
 * path derived as its `col_end_0`).
 */
export function mapSyntaxDiagnostics(diagnostics: SyntaxDiagnostic[]): SqlglotWarning[] {
	return diagnostics.map(d => ({
		type: 'syntax_error' as const,
		message: d.message,
		line: d.line - 1,
		col: d.column,
		endCol: d.column + d.length,
	}));
}

/**
 * Map sqllens qualify diagnostics to `scope_warning` warnings.
 *
 * sqllens: `line`/`endLine` 1-based, `column`/`endColumn` 0-based (end one past the last
 * char). The `SqlglotWarning` fields are single-line, so `line - 1` and the start/end
 * columns are carried straight through.
 */
export function mapQualifyDiagnostics(diagnostics: Diagnostic[]): SqlglotWarning[] {
	return diagnostics.map(d => ({
		type: 'scope_warning' as const,
		message: d.message,
		line: d.line - 1,
		col: d.column,
		endCol: d.endColumn,
	}));
}

/**
 * Collect all warnings for `sql`: syntax errors always; scope warnings only when the
 * parse is clean (a scope_warning means "parsed OK but the analyzer objects", so it is
 * meaningless noise over a broken parse — the same gate the sqlglot path implied by
 * emitting scope warnings from a successfully-built scope only).
 */
export function collectWarnings(sql: string, dialect: Dialect, schema?: SchemaMapping): SqlglotWarning[] {
	const parsed = parse(sql, dialect);
	const syntax = mapSyntaxDiagnostics(parsed.diagnostics);
	if (parsed.errors > 0) return syntax;
	const q = qualify(parsed.ast, new Schema(schema ?? {}), { dialect });
	return [...syntax, ...mapQualifyDiagnostics(q.diagnostics)];
}
