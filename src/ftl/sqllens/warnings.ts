/**
 * sqllens-backed parse/scope warnings — parse diagnostics and schema-fed
 * resolution errors that the extension consumes as {@link ParseWarning}
 * (`src/services/parse-service.ts`).
 *
 * Two sqllens diagnostic sources map onto the two warning types:
 *
 * - **syntax_error** ← `parse().diagnostics` (`SyntaxDiagnostic`): outright parse failures.
 * - **scope_warning** ← `qualify().diagnostics` (`Diagnostic`): schema-fed resolution
 *   problems (unknown table/column/field, ambiguous column). The legacy
 *   "cannot analyse a CTE scope" failure doesn't apply to sqllens — `resolveScopes`
 *   is total — so the schema-fed qualify diagnostics cover "SQL parsed OK but the
 *   analyzer objects" signals.
 *
 * Position conversions adapt from ANTLR-native to the extension's `ParseWarning` format.
 * sqllens positions: `line` 1-based, `column`/`endColumn` 0-based (end one past the last char).
 * The extension's `ParseWarning` wants 0-based `line`, 0-based start `col`, and
 * 0-based exclusive `endCol`.
 */
import { parse, qualify, Schema } from 'sqllens';
import type { Diagnostic, Dialect, SchemaMapping, SyntaxDiagnostic } from 'sqllens';

/**
 * A structural issue detected during parsing / analysis (mirrors the extension's
 * `ParseWarning`, `src/services/parse-service.ts`).
 *
 * - `syntax_error`: a parse failure; `line`/`col`/`endCol` point at the bad token.
 * - `scope_warning`: SQL parsed OK but the schema-fed analysis objects (unknown /
 *   ambiguous column, unknown table/field).
 */
export interface ParseWarning {
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
 * Conversion to ParseWarning: `line - 1` (0-based), `col = column` (0-based start), and
 * `endCol = column + length` (0-based exclusive end).
 */
export function mapSyntaxDiagnostics(diagnostics: SyntaxDiagnostic[]): ParseWarning[] {
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
 * char). The `ParseWarning` fields are single-line, so `line - 1` and the start/end
 * columns are carried straight through.
 */
export function mapQualifyDiagnostics(diagnostics: Diagnostic[]): ParseWarning[] {
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
 * meaningless noise over a broken parse — emit scope warnings only from
 * successfully-built scopes).
 */
export function collectWarnings(sql: string, dialect: Dialect, schema?: SchemaMapping): ParseWarning[] {
	const parsed = parse(sql, dialect);
	const syntax = mapSyntaxDiagnostics(parsed.diagnostics);
	if (parsed.errors > 0) return syntax;
	const q = qualify(parsed.ast, new Schema(schema ?? {}), { dialect });
	return [...syntax, ...mapQualifyDiagnostics(q.diagnostics)];
}
