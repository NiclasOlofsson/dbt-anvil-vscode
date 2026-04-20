import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';
import { replaceOp } from '../fix-op';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

// SQL datatype keywords that should follow capitalisation policy.
const SQL_TYPES = new Set([
	'int', 'integer', 'bigint', 'smallint', 'tinyint', 'mediumint',
	'float', 'double', 'decimal', 'numeric', 'real', 'number',
	'boolean', 'bool',
	'varchar', 'char', 'character', 'text', 'string', 'nvarchar', 'nchar',
	'clob', 'nclob', 'blob', 'binary', 'varbinary', 'bytea', 'bytes',
	'date', 'datetime', 'timestamp', 'timestamptz', 'timestamp_tz',
	'timestamp_ltz', 'timestamp_ntz', 'time', 'timetz', 'interval',
	'json', 'jsonb', 'xml', 'uuid', 'geography', 'geometry',
	'array', 'map', 'struct', 'object', 'variant', 'any',
	'hllsketch', 'super',
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

/** CP05: Datatype keywords should follow the configured capitalisation policy. */
export const typeCapRule: TokenRule = {
	id: 'ninja.cap.types',
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'warning',
	description: 'SQL datatype keywords should follow the configured capitalisation policy',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'capitalisation.types', label: 'Style', type: 'enum', choices: ['upper', 'lower', 'consistent'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.types;
		const violations: NinjaViolation[] = [];
		const consistentMap = new Map<string, string>();
		const sqlTokens = sqlOnly(ctx.model.ninjaSqlTokens);
		const commentSpans = sqlTokens.flatMap(t => t.comments ?? []);
		// String-literal spans must be excluded too — type keywords inside string content
		// would otherwise be incorrectly flagged (e.g. select 'INT column' as label).
		const stringSpans = sqlTokens
			.filter(t => t.type === 'STRING')
			.map(t => ({ start: t.start, end: t.end + 1 }));

		const text = ctx.document.getText();
		const lines = text.split('\n');
		let absOffset = 0; // running byte offset into text (matches sqlTokens coordinate space)

		// Build identifier positions to skip
		const identifierPositions = new Set<string>();
		for (const token of ctx.model.tokens) {
			identifierPositions.add(`${token.line}:${token.col}`);
		}

		const types = ctx.dialectSymbols?.types ?? SQL_TYPES;

		for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
			const line = lines[lineIdx];
			let i = 0;
			const lineStart = absOffset;
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
					const absWordStart = lineStart + start;
					const inComment = commentSpans.some(s => absWordStart >= s.start && absWordStart < s.end);
					const inString = stringSpans.some(s => absWordStart >= s.start && absWordStart < s.end);
					if (!inComment && !inString && types.has(word.toLowerCase()) && !identifierPositions.has(`${lineIdx}:${start}`)) {
						const fix = checkPolicy(word, policy, consistentMap);
						if (fix !== undefined) {
							const range = new vscode.Range(lineIdx, start, lineIdx, start + word.length);
							violations.push({
								rule: 'ninja.cap.types',
								message: `Expected type '${word}' to be '${fix}'`,
								range,
								action: { type: FixAction.TYPE, ops: [replaceOp(range, fix)], autoFix: true },
							});
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
