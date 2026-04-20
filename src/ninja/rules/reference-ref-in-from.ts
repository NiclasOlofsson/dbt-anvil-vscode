/**
 * RF01 — verify that every {{ ref() }} call appears in a FROM or JOIN clause,
 * not in a SELECT body, WHERE condition, or other non-table-reference position.
 *
 * We detect context purely from the NinjaSqlToken stream: the clause keyword
 * immediately preceding each jinja token must be FROM or a JOIN-family word.
 * Conservative — jinja that can't be located in the stream is silently skipped.
 */

import * as vscode from 'vscode';
import { NinjaCategory } from '../categories';
import type { TokenRule, TokenRuleContext } from '../rule';
import type { NinjaViolation } from '../violation';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';

const FROM_CONTEXT = new Set(['FROM', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER']);
const CLAUSE_KEYWORDS = new Set([
	'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT',
	'QUALIFY', 'WINDOW', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
	'ON', 'USING', 'SET', 'UPDATE', 'INSERT', 'DELETE',
]);

function lastClauseKeyword(tokens: NinjaSqlToken[], refStart: number): string | undefined {
	let depth = 0;
	let last: string | undefined;
	for (const t of tokens) {
		if (t.start >= refStart) break;
		if (t.category === 'sql') {
			if (t.type === 'L_PAREN') { depth++; continue; }
			if (t.type === 'R_PAREN') { depth--; continue; }
			if (depth === 0 && CLAUSE_KEYWORDS.has(t.type)) last = t.type;
		}
	}
	return last;
}

export const refInFromRule: TokenRule = {
	id: 'ninja.reference.ref-in-from',
	type: 'token',
	category: NinjaCategory.Reference,
	defaultSeverity: 'warning',
	description: '{{ ref() }} calls must appear in a FROM or JOIN clause, not in SELECT bodies or conditions.',

	check(ctx: TokenRuleContext): NinjaViolation[] {
		const { model, document } = ctx;
		if (!model.refs || model.refs.length === 0) return [];
		const tokens = model.ninjaSqlTokens;
		if (!tokens || tokens.length === 0) return [];

		const violations: NinjaViolation[] = [];

		for (const ref of model.refs) {
			const refLine = ref.line;
			const refCol = ref.jinjaCol ?? ref.col;
			const jinjaToken = tokens.find(
				t => t.category === 'jinja' && t.line === refLine && t.col === refCol,
			);
			if (!jinjaToken) continue;

			const kw = lastClauseKeyword(tokens, jinjaToken.start);
			if (kw === undefined || FROM_CONTEXT.has(kw)) continue;

			violations.push({
				rule: 'ninja.reference.ref-in-from',
				message: `{{ ref('${ref.model}') }} is used in a ${kw} context — ref() calls should only appear in FROM or JOIN clauses.`,
				range: new vscode.Range(
					document.positionAt(jinjaToken.start),
					document.positionAt(jinjaToken.end),
				),
			});
		}

		return violations;
	},
};
