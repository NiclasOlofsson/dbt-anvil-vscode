import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';

// Common SQL aggregate/scalar/window functions.
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

function checkPolicy(word: string, policy: CapitalisationPolicy, expected: Map<string, string>): string | undefined {
	if (policy === 'upper') {
		const upper = word.toUpperCase();
		return word !== upper ? upper : undefined;
	}
	if (policy === 'lower') {
		const lower = word.toLowerCase();
		return word !== lower ? lower : undefined;
	}
	const key = word.toLowerCase();
	const first = expected.get(key);
	if (!first) {
		expected.set(key, word);
		return undefined;
	}
	return word !== first ? first : undefined;
}

export const functionCapRule: TokenRule = {
	id: 'ninja.cap.functions',
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'warning',
	description: 'SQL function names should follow the configured capitalisation policy',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.functions;
		const violations: NinjaViolation[] = [];
		const consistentMap = new Map<string, string>();

		const functions = ctx.dialectSymbols?.functions ?? SQL_FUNCTIONS;
		const text = ctx.document.getText();
		const lines = text.split('\n');

		// Build identifier positions to skip
		const identifierPositions = new Set<string>();
		for (const token of ctx.model.tokens) {
			identifierPositions.add(`${token.line}:${token.col}`);
		}

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			const line = lines[lineIdx];
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
					// A function name is followed by '(' (possibly with whitespace)
					let j = i;
					while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
					if (j < line.length && line[j] === '(' && functions.has(word.toLowerCase()) && !identifierPositions.has(`${lineIdx}:${start}`)) {
						const fix = checkPolicy(word, policy, consistentMap);
						if (fix !== undefined) {
							const range = new vscode.Range(lineIdx, start, lineIdx, start + word.length);
							violations.push({
								rule: 'ninja.cap.functions',
								message: `Expected function '${word}' to be '${fix}'`,
								range,
									action: { type: FixAction.TYPE, edits: [vscode.TextEdit.replace(range, fix)], autoFix: true },
							});
						}
					}
				} else {
					i++;
				}
			}
		}

		return violations;
	},
};
