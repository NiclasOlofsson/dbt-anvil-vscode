import { NinjaCategory } from '../categories';
import { FixAction, type NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';
import { replaceOp } from '../fix-op';
import { tokenText, tokenRange } from '../token-utils';
import { sqlOnly } from '../../ftl/ninja-sql-tokens';

const RULE_ID = 'ninja.cap.keywords';

// TokenType names that represent SQL keywords.
// All stored lowercase for comparison against token.type.toLowerCase().
// Includes compound token types for multi-word keywords:
// `ALIAS` (the AS keyword), `GROUP_BY`, `ORDER_BY`, `ISNULL`, `NOTNULL`, etc.
// For compound tokens, `tokenText` returns the raw multi-word slice
// (e.g. "GROUP BY"), and the replace pass lowercases it intact.
const KEYWORD_TOKEN_TYPES = new Set([
	'select', 'from', 'where', 'and', 'or', 'not', 'in', 'is', 'null',
	'as', 'alias', 'on', 'join', 'left', 'right', 'inner', 'outer', 'full', 'cross',
	'group', 'by', 'order', 'having', 'limit', 'offset', 'union', 'all',
	'group_by', 'order_by', 'order_siblings_by', 'distribute_by',
	'isnull', 'notnull',
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
	id: RULE_ID,
	type: 'token',
	category: NinjaCategory.Capitalisation,
	defaultSeverity: 'hint',
	description: 'SQL keywords should follow the configured capitalisation policy',
	actionKinds: ['fix'],
	autoFixable: true,
	configOptions: [{ settingPath: 'capitalisation.keywords', label: 'Style', type: 'enum', choices: ['upper', 'lower', 'consistent'] }],

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const policy = ctx.config.capitalisation.keywords;
		const violations: NinjaViolation[] = [];
		const consistentMap = new Map<string, string>();

		const sqlTokens = sqlOnly(ctx.model.ninjaSqlTokens);
		if (sqlTokens.length === 0) return violations;

		const text = ctx.document.getText();

		const keywordTypes = ctx.dialectSymbols?.keywordTokenTypes ?? KEYWORD_TOKEN_TYPES;

		for (const token of sqlTokens) {
			if (!keywordTypes.has(token.type.toLowerCase())) continue;

			const word = tokenText(text, token);
			const fix = checkPolicy(word, policy, consistentMap);
			if (fix !== undefined) {
				const range = tokenRange(text, token);
				violations.push({
					rule: RULE_ID,
					message: `Expected keyword '${word}' to be '${fix}'`,
					range,
					action: { type: FixAction.TYPE, ops: [replaceOp(range, fix)], autoFix: true },
				});
			}
		}

		return violations;
	},
};
