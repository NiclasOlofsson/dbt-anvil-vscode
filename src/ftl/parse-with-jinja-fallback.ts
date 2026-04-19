import { blankJinja } from '../dbt/jinja-blanker';
import type { JinjaTagInfo } from '../dbt/jinja-blanker';
import { renderForParse } from './nunjucks-renderer';
import type { LineMap } from './nunjucks-renderer';

export type ParsePass = 'pass1' | 'pass1b' | 'pass2';

export interface ParseWithFallbackResult<T> {
	result: T;
	pass: ParsePass;
	lineMap?: LineMap;
	/**
	 * Maps each unique jinja ID (e.g. `__j0__`) to the original tag it replaced.
	 * Populated from the pass that succeeded — pass1 or pass1b.
	 * Empty for pass2 (nunjucks render uses its own substitution scheme).
	 */
	idMap: Map<string, JinjaTagInfo>;
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
 *   1.  length-preserving blank, identifier mode (unique IDs for unknown macros)
 *   1b. length-preserving blank, comment mode (handles statement-level macros)
 *   2.  nunjucks stub render (valid SQL everywhere, but offsets shift)
 */
export function parseWithJinjaFallback<T>(
	rawSql: string,
	runOnce: (sql: string, pass: ParsePass, lineMap?: LineMap) => T,
	isSuccess: (r: T) => boolean,
): ParseWithFallbackResult<T> {
	const b1 = blankJinja(rawSql);
	const r1 = runOnce(b1.blanked, 'pass1');
	if (isSuccess(r1)) return { result: r1, pass: 'pass1', idMap: b1.idMap };

	const b1b = blankJinja(rawSql, 'comment');
	const r1b = runOnce(b1b.blanked, 'pass1b');
	if (isSuccess(r1b)) return { result: r1b, pass: 'pass1b', idMap: b1b.idMap };

	const { rendered, lineMap } = renderForParse(rawSql);
	const r2 = runOnce(rendered, 'pass2', lineMap);
	return { result: r2, pass: 'pass2', lineMap, idMap: new Map() };
}
