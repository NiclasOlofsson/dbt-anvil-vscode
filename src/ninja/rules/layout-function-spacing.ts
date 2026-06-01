import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { LayoutRule, LayoutRuleContext } from '../rule';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';
import { deleteOp } from '../fix-op';

// Common SQL aggregate/scalar/window functions (same set as cap-functions).
const SQL_FUNCTIONS = new Set([
	'count', 'sum', 'avg', 'min', 'max', 'coalesce', 'nullif', 'ifnull',
	'nvl', 'nvl2', 'iif', 'iff', 'greatest', 'least', 'abs', 'ceil',
	'ceiling', 'floor', 'round', 'trunc', 'truncate', 'mod', 'power',
	'sqrt', 'log', 'ln', 'exp', 'sign', 'random', 'rand',
	'length', 'len', 'char_length', 'character_length', 'octet_length',
	'upper', 'lower', 'trim', 'ltrim', 'rtrim', 'lpad', 'rpad',
	'left', 'right', 'substring', 'substr', 'replace', 'reverse',
	'concat', 'concat_ws', 'split_part', 'position', 'strpos', 'instr',
	'repeat', 'space', 'ascii', 'chr', 'char', 'initcap', 'translate',
	'regexp_replace', 'regexp_extract', 'regexp_like', 'regexp_count',
	'regexp_substr', 'regexp_instr',
	'now', 'current_date', 'current_timestamp', 'current_time',
	'date', 'time', 'timestamp', 'dateadd', 'datediff', 'date_add',
	'date_sub', 'date_diff', 'date_trunc', 'date_part', 'extract',
	'year', 'month', 'day', 'hour', 'minute', 'second',
	'to_date', 'to_timestamp', 'to_char', 'to_number',
	'cast', 'try_cast', 'convert', 'typeof', 'type_of',
	'row_number', 'rank', 'dense_rank', 'ntile', 'lag', 'lead',
	'first_value', 'last_value', 'nth_value',
	'listagg', 'string_agg', 'group_concat', 'array_agg',
	'any_value', 'approx_count_distinct', 'count_if', 'countif',
	'json_extract', 'json_extract_scalar', 'json_value', 'json_query',
	'parse_json', 'to_json', 'from_json',
	'array', 'unnest', 'generate_series', 'sequence',
	'hash', 'md5', 'sha1', 'sha256', 'sha2',
	'decode', 'encode', 'base64_encode', 'base64_decode',
	'if', 'zeroifnull', 'nullifzero',
	'object_construct', 'object_keys', 'array_construct', 'array_size',
	'flatten', 'lateral', 'table', 'result_scan',
	'contains', 'startswith', 'endswith', 'like', 'ilike',
	'try_to_number', 'try_to_date', 'try_to_timestamp',
	'median', 'mode', 'percentile_cont', 'percentile_disc',
	'stddev', 'stddev_pop', 'stddev_samp', 'variance', 'var_pop', 'var_samp',
	'corr', 'covar_pop', 'covar_samp', 'regr_slope', 'regr_intercept',
	'cume_dist', 'percent_rank',
	'width_bucket', 'bit_and', 'bit_or', 'bit_xor', 'bool_and', 'bool_or',
]);

/**
 * LT06: No space before function parenthesis.
 * `count (*)` → `count(*)`
 *
 * Scans for function-name words followed by whitespace then `(`.
 */
export const functionSpacingRule: LayoutRule = {
	id: 'ninja.layout.function_spacing',
	type: 'layout',
	category: NinjaCategory.Layout,
	defaultSeverity: 'hint',
	description: 'No space between function name and opening parenthesis',
	actionKinds: ['fix'],
	autoFixable: true,

	check(ctx: LayoutRuleContext): NinjaViolation[] {
		const violations: NinjaViolation[] = [];
		const sqlTokens = sqlOnly(ctx.model?.ninjaSqlTokens);
		const commentSpans = sqlTokens.flatMap(t => t.comments ?? []);
		// String-literal spans must also mask out content; otherwise function names inside
		// quoted text would be flagged when the spacing pattern happens to match.
		const stringSpans = sqlTokens
			.filter(t => t.type === 'STRING')
			.map(t => ({ start: t.start, end: t.end + 1 }));

		let absOffset = 0; // running byte offset into ctx.text (matches sqlTokens coordinate space)

		for (let lineIdx = 0; lineIdx < ctx.lines.length; lineIdx++) {
			const line = ctx.lines[lineIdx];
			let i = 0;
			while (i < line.length) {
				const ch = line.charCodeAt(i);
				if ((ch >= 65 && ch <= 90) || (ch >= 97 && ch <= 122) || ch === 95) {
					const start = i;
					i++;
					while (i < line.length) {
						const c = line.charCodeAt(i);
						if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95) {
							i++;
						} else {
							break;
						}
					}
					const word = line.slice(start, i);
					if (SQL_FUNCTIONS.has(word.toLowerCase())) {
						const absWordStart = absOffset + start;
						const inComment = commentSpans.some(s => absWordStart >= s.start && absWordStart < s.end);
						const inString = stringSpans.some(s => absWordStart >= s.start && absWordStart < s.end);
						if (!inComment && !inString) {
							let j = i;
							const spaceStart = j;
							while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
							if (j > spaceStart && j < line.length && line[j] === '(') {
								const range = new vscode.Range(lineIdx, spaceStart, lineIdx, j);
								violations.push({
									rule: 'ninja.layout.function_spacing',
									message: `Unexpected space before '(' in function call '${word}'`,
									range,
									action: { type: FixAction.TYPE, ops: [deleteOp(range)], autoFix: true },
								});
							}
						}
					}
				} else {
					i++;
				}
			}
			absOffset += line.length + 1; // +1 for the '\n' consumed by split
		}

		return violations;
	},
};
