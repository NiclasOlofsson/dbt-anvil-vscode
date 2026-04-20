import type { ParseWarning } from '../parse-result';
import type { JinjaToken } from '../jinja-tokenizer';
import type { RefInfo, SourceInfo, SqlglotWarning } from '../../services/parse-service';

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

export function mapWarnings(warnings: ParseWarning[]): SqlglotWarning[] {
	return warnings.map(w => ({
		type: w.type,
		message: w.message,
		...(w.line !== undefined && { line: w.line }),
		...(w.col !== undefined && { col: w.col }),
		...(w.endCol !== undefined && { endCol: w.endCol }),
	}));
}
