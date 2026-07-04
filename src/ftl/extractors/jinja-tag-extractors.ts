import type { ParseWarning } from '../parse-result';
import type { JinjaToken } from '../jinja-tokenizer';
import type { MacroCallInfo, MacroCallArgInfo, RefInfo, SourceInfo, SqlglotWarning } from '../../services/parse-service';

/**
 * Jinja keywords and dbt globals that may appear as `identifier(` but are NOT
 * user-defined macro calls. `ref` and `source` have dedicated extractors;
 * the rest are control flow, statement keywords, or jinja built-ins.
 */
export const NOT_MACRO_CALLS = new Set([
	'ref', 'source',
	'if', 'elif', 'else', 'endif',
	'for', 'endfor', 'in',
	'block', 'endblock',
	'macro', 'endmacro',
	'call', 'endcall',
	'set', 'endset', 'do',
	'with', 'endwith',
	'filter', 'endfilter',
	'from', 'import', 'as', 'include', 'extends',
	'raw', 'endraw',
	'not', 'and', 'or', 'is',
	'none', 'None', 'true', 'True', 'false', 'False',
	'config', 'var', 'env_var',
]);

/**
 * Walk the jinja token stream and pick out `{{ ref('name') }}` calls.
 *
 * Pattern matched per `jinja_expression_open`:
 *   `ref` `(` STRING `)`  (whitespace tokens are not emitted by the tokenizer)
 *
 * Column math assumes the call sits on a single line, which is virtually
 * always true for `ref()` calls in dbt SQL. Multi-line tags would already
 * have been lossy under the previous JinjaTagSpan-based implementation
 * (only one `line` was stored), so this preserves existing behavior.
 */
export function extractRefs(jinjaTokens: JinjaToken[]): RefInfo[] {
	const refs: RefInfo[] = [];
	for (let i = 0; i < jinjaTokens.length; i++) {
		const open = jinjaTokens[i];
		if (open.type !== 'jinja_expression_open' || open.tagEnd === undefined) continue;

		// Scan inside the tag for the `ref(` call.
		const tagEnd = open.tagEnd;
		for (let j = i + 1; j < jinjaTokens.length && jinjaTokens[j].start < tagEnd; j++) {
			const id = jinjaTokens[j];
			if (id.type !== 'jinja_identifier' || id.value !== 'ref') continue;
			const lparen = jinjaTokens[j + 1];
			const arg = jinjaTokens[j + 2];
			const rparen = jinjaTokens[j + 3];
			if (
				lparen?.type !== 'jinja_paren_open' ||
				arg?.type !== 'jinja_string' ||
				rparen?.type !== 'jinja_paren_close'
			) continue;

			refs.push({
				model: arg.value,
				line: id.line,
				col: id.col,
				modelCol: arg.col + 1,                       // skip opening quote
				modelEndCol: arg.col + (arg.end - arg.start) - 1,  // col of closing quote
				jinjaCol: open.col,
				jinjaEndCol: open.col + (tagEnd - open.start),
			});
			break;
		}
	}
	return refs;
}

/**
 * Walk the jinja token stream and pick out `{{ source('schema', 'table') }}` calls.
 *
 * Pattern matched per `jinja_expression_open`:
 *   `source` `(` STRING `,` STRING `)`
 */
export function extractSources(jinjaTokens: JinjaToken[]): SourceInfo[] {
	const sources: SourceInfo[] = [];
	for (let i = 0; i < jinjaTokens.length; i++) {
		const open = jinjaTokens[i];
		if (open.type !== 'jinja_expression_open' || open.tagEnd === undefined) continue;

		const tagEnd = open.tagEnd;
		for (let j = i + 1; j < jinjaTokens.length && jinjaTokens[j].start < tagEnd; j++) {
			const id = jinjaTokens[j];
			if (id.type !== 'jinja_identifier' || id.value !== 'source') continue;
			const lparen = jinjaTokens[j + 1];
			const arg1 = jinjaTokens[j + 2];
			const comma = jinjaTokens[j + 3];
			const arg2 = jinjaTokens[j + 4];
			const rparen = jinjaTokens[j + 5];
			if (
				lparen?.type !== 'jinja_paren_open' ||
				arg1?.type !== 'jinja_string' ||
				comma?.type !== 'jinja_comma' ||
				arg2?.type !== 'jinja_string' ||
				rparen?.type !== 'jinja_paren_close'
			) continue;

			sources.push({
				sourceName: arg1.value,
				tableName: arg2.value,
				line: id.line,
				col: id.col,
				sourceNameCol: arg1.col + 1,
				sourceNameEndCol: arg1.col + (arg1.end - arg1.start) - 1,
				tableNameCol: arg2.col + 1,
				tableNameEndCol: arg2.col + (arg2.end - arg2.start) - 1,
				jinjaCol: open.col,
				jinjaEndCol: open.col + (tagEnd - open.start),
			});
			break;
		}
	}
	return sources;
}

/**
 * Walk the jinja token stream and pick out user-defined macro call sites:
 *   `{{ my_macro(...) }}`
 *   `{{ dbt_utils.pivot(...) }}`
 *   `{% set x = my_macro(...) %}`
 *   `{% if my_macro(...) %}`
 *   `{% call my_macro() %}...{% endcall %}`
 *
 * Tag-scoped: scans every `jinja_expression_open` and `jinja_block_open`
 * region, terminated by the open's `tagEnd`. Multi-line tags work naturally
 * because token offsets are absolute.
 *
 * A call site is `identifier paren_open`, optionally prefixed by
 * `identifier dot` (package qualifier). The bare identifier is rejected
 * when it is in `NOT_MACRO_CALLS` (jinja keywords, dbt globals, ref/source
 * which have dedicated extractors) or when the previous token is the
 * keyword `macro` (definition site, not a call).
 *
 * Argument spans are recorded for signature-help: each arg is the inclusive
 * range from its first token to the token before the next top-level comma
 * (or the closing paren). Nested parens are tracked so commas inside them
 * don't split args.
 */
export function extractMacroCalls(jinjaTokens: JinjaToken[]): MacroCallInfo[] {
	const calls: MacroCallInfo[] = [];

	for (let i = 0; i < jinjaTokens.length; i++) {
		const open = jinjaTokens[i];
		if (
			(open.type !== 'jinja_expression_open' && open.type !== 'jinja_block_open') ||
			open.tagEnd === undefined
		) continue;

		const tagEnd = open.tagEnd;

		// Tokens inside this tag (exclusive of the close)
		let j = i + 1;
		while (j < jinjaTokens.length && jinjaTokens[j].start < tagEnd) {
			const lparen = jinjaTokens[j];
			if (lparen.type !== 'jinja_paren_open') { j++; continue; }

			const nameTok = jinjaTokens[j - 1];
			if (!nameTok || nameTok.type !== 'jinja_identifier') { j++; continue; }

			// Skip jinja keywords / ref / source / dbt globals
			if (NOT_MACRO_CALLS.has(nameTok.value)) { j++; continue; }

			// Skip `{% macro foo() %}` definition site: the name is preceded by
			// the keyword `macro`, optionally with no other tokens between.
			const prevTok = jinjaTokens[j - 2];
			if (prevTok?.type === 'jinja_identifier' && prevTok.value === 'macro') { j++; continue; }

			// Detect `package.name(` — packageTok is `jinja_identifier`, sep is `jinja_dot`
			let packageTok: JinjaToken | undefined;
			if (prevTok?.type === 'jinja_dot') {
				const pkg = jinjaTokens[j - 3];
				if (pkg?.type === 'jinja_identifier' && !NOT_MACRO_CALLS.has(pkg.value)) {
					packageTok = pkg;
				}
			}

			// Walk args: track nested paren depth; split on top-level commas.
			const args: MacroCallArgInfo[] = [];
			let depth = 1;
			let argStart = j + 1;
			let k = j + 1;
			let closeIdx = -1;
			for (; k < jinjaTokens.length && jinjaTokens[k].start < tagEnd; k++) {
				const t = jinjaTokens[k];
				if (t.type === 'jinja_paren_open') { depth++; continue; }
				if (t.type === 'jinja_paren_close') {
					depth--;
					if (depth === 0) {
						if (k > argStart) {
							const first = jinjaTokens[argStart];
							const last = jinjaTokens[k - 1];
							args.push({ line: first.line, col: first.col, endCol: last.col + (last.end - last.start) });
						}
						closeIdx = k;
						break;
					}
					continue;
				}
				if (t.type === 'jinja_comma' && depth === 1) {
					if (k > argStart) {
						const first = jinjaTokens[argStart];
						const last = jinjaTokens[k - 1];
						args.push({ line: first.line, col: first.col, endCol: last.col + (last.end - last.start) });
					}
					argStart = k + 1;
				}
			}

			calls.push({
				name: nameTok.value,
				...(packageTok ? { packageName: packageTok.value } : {}),
				line: nameTok.line,
				col: nameTok.col,
				endCol: nameTok.col + (nameTok.end - nameTok.start),
				...(packageTok ? {
					packageCol: packageTok.col,
					packageEndCol: packageTok.col + (packageTok.end - packageTok.start),
				} : {}),
				jinjaCol: open.col,
				jinjaEndCol: open.col + (tagEnd - open.start),
				jinjaLine: open.line,
				argsCol: lparen.col,
				...(closeIdx >= 0 ? {
					argsEndCol: jinjaTokens[closeIdx].col + (jinjaTokens[closeIdx].end - jinjaTokens[closeIdx].start),
				} : {}),
				args,
			});

			// Advance one token. Nested calls (`outer(inner(...))`) are picked
			// up when the outer iteration reaches the inner `(`.
			j++;
		}
	}

	return calls;
}

export function mapWarnings(warnings: ParseWarning[]): SqlglotWarning[] {
	return warnings.map(w => ({
		type: w.type,
		message: w.message,
		...(w.line !== undefined && { line: w.line }),
		...(w.col !== undefined && { col: w.col }),
		...(w.endCol !== undefined && { endCol: w.endCol }),
	}));
}
