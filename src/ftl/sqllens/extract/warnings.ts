/**
 * Map sqllens syntax diagnostics to the extension's `ParseWarning[]`.
 *
 * Only `syntax_error` is produced. The legacy `scope_warning` ("SQL parsed
 * but a CTE scope can't be analysed") doesn't apply to sqllens — `resolveScopes()`
 * is total and always builds a scope for a valid IR; schema-fed problems surface
 * later as qualify diagnostics (unknown-table/column), a materially different
 * concept the structural DocumentModel does not carry. See EXTRACTOR-MAP §7.
 */
import type { ParseWarning } from '../../../services/parse-service';
import type { SyntaxDiagnostic } from '../api';

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
