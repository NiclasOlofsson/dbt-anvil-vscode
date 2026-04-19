import { blankJinja } from '../dbt/jinja-blanker';
import { renderForParse } from './nunjucks-renderer';
import type { LineMap } from './nunjucks-renderer';

export type ParsePass = 'pass1' | 'pass1b' | 'pass2';

export interface ParseWithFallbackResult<T> {
	result: T;
	pass: ParsePass;
	lineMap?: LineMap;
}

/**
 * Run the three-pass jinja-blanking cascade for a single SQL string.
 *
 * The caller supplies `runOnce` (which actually invokes Pyodide) and
 * `isSuccess` (which decides whether to short-circuit). Caller-specific
 * post-processing — line/column remapping, swapping pass-1 sqlTokens back in,
 * setting `isPass2` — stays at the call site and runs only when the returned
 * `pass` is `'pass2'`.
 *
 * Passes:
 *   1.  length-preserving blank, identifier mode (preserves source offsets)
 *   1b. length-preserving blank, comment mode (handles statement-level macros)
 *   2.  nunjucks stub render (valid SQL everywhere, but offsets shift)
 */
export function parseWithJinjaFallback<T>(
	rawSql: string,
	runOnce: (sql: string, pass: ParsePass, lineMap?: LineMap) => T,
	isSuccess: (r: T) => boolean,
): ParseWithFallbackResult<T> {
	const r1 = runOnce(blankJinja(rawSql), 'pass1');
	if (isSuccess(r1)) return { result: r1, pass: 'pass1' };

	const r1b = runOnce(blankJinja(rawSql, 'comment'), 'pass1b');
	if (isSuccess(r1b)) return { result: r1b, pass: 'pass1b' };

	const { rendered, lineMap } = renderForParse(rawSql);
	const r2 = runOnce(rendered, 'pass2', lineMap);
	return { result: r2, pass: 'pass2', lineMap };
}
