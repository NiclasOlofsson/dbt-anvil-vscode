/**
 * Map sqllens diagnostics to the extension's `ParseWarning[]`.
 *
 * Two sources, two warning types:
 * - `syntax_error` ← `parse().diagnostics` (`SyntaxDiagnostic`) — outright parse failures.
 * - `scope_warning` ← `qualify().diagnostics` — schema-fed column-resolution problems
 *   (unknown / ambiguous column, unknown struct field). Column kinds only: unknown-table
 *   never fires against our open-world provider, and the call-signature kinds
 *   (wrong-arity / wrong-argument-type) are a different editor surface, deliberately
 *   not mapped here.
 */
import type { ParseWarning } from '../../../services/parse-service';
import type { Diagnostic, SyntaxDiagnostic } from '../api';

export function mapDiagnostics(diagnostics: SyntaxDiagnostic[]): ParseWarning[] {
	return diagnostics.map(d => ({
		type: 'syntax_error' as const,
		message: d.message,
		// antlr line is 1-based; column is 0-based; length is the offending token's width.
		line: d.line - 1,
		col: d.column,
		endCol: d.column + d.length,
	}));
}

const COLUMN_KINDS: ReadonlySet<Diagnostic['kind']> = new Set(
	['unknown-column', 'ambiguous-column', 'unknown-field'] as const,
);

/** sqllens qualify positions: `line`/`endLine` 1-based, `column`/`endColumn` 0-based
 *  end-exclusive — carried straight through to the 0-based single-line ParseWarning. */
export function mapQualifyDiagnostics(diagnostics: readonly Diagnostic[]): ParseWarning[] {
	return diagnostics
		.filter(d => COLUMN_KINDS.has(d.kind))
		.map(d => ({
			type: 'scope_warning' as const,
			message: d.message,
			line: d.line - 1,
			col: d.column,
			endCol: d.endColumn,
		}));
}
