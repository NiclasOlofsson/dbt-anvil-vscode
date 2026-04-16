import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';
import { tokenText, tokenRange } from '../token-utils';

// sqlglot TokenType names that represent SQL keywords.
// All stored lowercase for comparison against token.type.toLowerCase().
const KEYWORD_TOKEN_TYPES = new Set([
	'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
	'as', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
	'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all',
	'distinct', 'case', 'when', 'then', 'else', 'end', 'with', 'recursive',
	'insert', 'into', 'values', 'update', 'set', 'delete', 'create', 'table',
	'drop', 'alter', 'index', 'view', 'if', 'exists', 'between', 'like',
	'ilike', 'asc', 'desc', 'nulls', 'first', 'last', 'over', 'partition',
	'window', 'rows', 'range', 'unbounded', 'preceding', 'following', 'current',
	'row', 'except', 'intersect', 'true', 'false', 'cast', 'using', 'natural',
	'lateral', 'any', 'some', 'qualify', 'pivot', 'unpivot', 'tablesample',
	'for', 'fetch', 'next', 'only', 'percent', 'top', 'returning', 'conflict',
	'do', 'nothing', 'replace', 'ignore', 'temporary', 'temp', 'materialized',
	'unique', 'primary', 'key', 'foreign', 'references', 'constraint', 'check',
	'default', 'cascade', 'restrict', 'no', 'action', 'grant', 'revoke',
	'begin', 'commit', 'rollback', 'savepoint', 'release', 'transaction',
	'explain', 'analyze', 'verbose', 'format', 'type', 'enum', 'interval',
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
	// consistent: use the first occurrence's casing
	const key = word.toLowerCase();
	const first = expected.get(key);
	if (!first) {
		expected.set(key, word);
		return undefined;
	}
	return word !== first ? first : undefined;
}

export const keywordCapRule: TokenRule = {
	id: 'ninja.cap.keywords',
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'warning',
	description: 'SQL keywords should follow the configured capitalisation policy',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.keywords;
		const violations: NinjaViolation[] = [];
		const consistentMap = new Map<string, string>();

		if (!ctx.model.sqlTokens) return violations;

		const text = ctx.document.getText();

		const keywordTypes = ctx.dialectSymbols?.keywordTokenTypes ?? KEYWORD_TOKEN_TYPES;

		for (const token of ctx.model.sqlTokens) {
			if (!keywordTypes.has(token.type.toLowerCase())) continue;

			const word = tokenText(text, token);
			const fix = checkPolicy(word, policy, consistentMap);
			if (fix !== undefined) {
				const range = tokenRange(text, token);
				violations.push({
					rule: 'ninja.cap.keywords',
					message: `Expected keyword '${word}' to be '${fix}'`,
					range,
					fix: [vscode.TextEdit.replace(range, fix)],
				});
			}
		}

		return violations;
	},
};
