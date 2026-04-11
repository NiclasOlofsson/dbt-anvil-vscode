import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { NinjaViolation } from '../violation';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { CapitalisationPolicy } from '../config';

// SQL keywords — comprehensive set covering common SQL dialects.
// All stored lowercase for comparison.
const SQL_KEYWORDS = new Set([
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

/**
 * Find SQL keyword tokens by scanning the blanked SQL text.
 * Uses DocumentModel tokens to skip known identifiers (column_ref, table_ref, column_def).
 * Returns an array of { word, line, col } for each keyword occurrence.
 */
function findKeywords(text: string, ctx: TokenRuleContext): Array<{ word: string; line: number; col: number }> {
	const lines = text.split('\n');
	const results: Array<{ word: string; line: number; col: number }> = [];

	// Build a set of positions occupied by known identifiers from the model
	// so we don't flag them as keywords.
	const identifierPositions = new Set<string>();
	for (const token of ctx.model.tokens) {
		identifierPositions.add(`${token.line}:${token.col}`);
		if ('table' in token && token.tableLine !== undefined && token.tableCol !== undefined) {
			identifierPositions.add(`${token.tableLine}:${token.tableCol}`);
		}
		if (token.type === 'table_ref' && token.alias && token.aliasLine !== undefined && token.aliasCol !== undefined) {
			identifierPositions.add(`${token.aliasLine}:${token.aliasCol}`);
		}
	}

	for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
		const line = lines[lineIdx];
		let i = 0;
		while (i < line.length) {
			const ch = line.charCodeAt(i);
			// Start of a word (letter or underscore)
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
				if (SQL_KEYWORDS.has(word.toLowerCase()) && !identifierPositions.has(`${lineIdx}:${start}`)) {
					results.push({ word, line: lineIdx, col: start });
				}
			} else {
				i++;
			}
		}
	}

	return results;
}

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

		// Use the blanked text from the document (jinja replaced with identifiers/spaces)
		// We scan for keywords in the raw document text, skipping jinja regions
		const text = ctx.document.getText();
		const keywords = findKeywords(text, ctx);

		for (const kw of keywords) {
			const fix = checkPolicy(kw.word, policy, consistentMap);
			if (fix !== undefined) {
				const range = new vscode.Range(kw.line, kw.col, kw.line, kw.col + kw.word.length);
				violations.push({
					rule: 'ninja.cap.keywords',
					message: `Expected keyword '${kw.word}' to be '${fix}'`,
					range,
					fix: [vscode.TextEdit.replace(range, fix)],
				});
			}
		}

		return violations;
	},
};
