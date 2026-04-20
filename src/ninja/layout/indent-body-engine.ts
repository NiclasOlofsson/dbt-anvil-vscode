/**
 * Clause-body indentation engine.
 *
 * Where the `indent-engine` handles specific trigger-token rules (ON under
 * JOIN, FROM peer of SELECT, etc.), this engine handles the *inverse* —
 * any content line that is NOT itself owned by another indent rule gets
 * aligned one level under its governing clause keyword.
 *
 * Phase 1 scope: clause bodies only. Bracket bodies (subqueries, CTEs) are
 * not handled here — they need a separate rule that uses the paren's line
 * as the anchor. That's a follow-up.
 *
 * ## State tracked during the walk
 * - Paren-depth stack. Each level remembers the most recent clause keyword
 *   at that depth.
 *   - `L_PAREN`/`LPAREN` pushes a new empty level.
 *   - `R_PAREN`/`RPAREN` pops.
 *   - A clause keyword overwrites the entry at the current depth (clauses
 *     are peers — FROM replaces SELECT as "the current clause", not stacked).
 *
 * ## When a line is flagged
 * For the first SQL token on a line:
 *   1. Not in `SKIP_ANCHOR_TYPES` (clause keywords, join words, set ops,
 *      CASE words, parens, AND/OR, commas — owned by other rules).
 *   2. There IS a current clause at the top of the stack.
 *   3. The clause is on a different line (not an inline statement).
 * Then expected col = `clause.col + indentSize`. Mismatch → event.
 */

import * as vscode from 'vscode';
import type { SqlToken } from '../../ftl/parse-result';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import { sqlOnly, jinjaLeadingLines } from '../../ftl/ninja-sql-tokens';
import type { NinjaConfig } from '../config';
import { tokenStartCol } from '../fix-utils';
import { replaceOp, type FixOp } from '../fix-op';

/** Clause keywords that open an indentable body. */
const CLAUSE_KEYWORDS: ReadonlySet<string> = new Set([
	'SELECT', 'FROM', 'WHERE', 'HAVING',
	'GROUP_BY', 'GROUP',
	'ORDER_BY', 'ORDER',
	'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW',
]);

/**
 * Token types that must NOT trigger a body-indent check when they appear
 * first on a line. These are either owned by another rule or are purely
 * structural / operator-continuation tokens.
 */
const SKIP_ANCHOR_TYPES: ReadonlySet<string> = new Set([
	// Clause keywords — handled by peer/indent rules.
	'SELECT', 'FROM', 'WHERE', 'HAVING',
	'GROUP_BY', 'GROUP', 'ORDER_BY', 'ORDER',
	'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW',
	'BY', // tail of split GROUP BY / ORDER BY
	// Join keywords — handled by indent-joins / indent-on.
	'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER', 'NATURAL',
	'ON', 'USING',
	// Set operators — handled by indent-set-op.
	'UNION', 'UNION_ALL', 'INTERSECT', 'EXCEPT',
	// CASE-expression sub-keywords — their positions follow CASE, not the
	// enclosing clause. CASE itself IS owned by this rule (it sits in the
	// clause body like any other expression).
	'WHEN', 'THEN', 'ELSE', 'END',
	// Alias / top-level structure keywords.
	'AS', 'WITH',
	// Structural tokens.
	'L_PAREN', 'LPAREN', 'R_PAREN', 'RPAREN',
	'L_BRACKET', 'LBRACKET', 'R_BRACKET', 'RBRACKET',
	'COMMA', 'SEMICOLON', 'DOT',
	// Logical operators — handled by convention-operator-position.
	'AND', 'OR', 'NOT',
]);

function isLParen(type: string) { return type === 'L_PAREN' || type === 'LPAREN'; }
function isRParen(type: string) { return type === 'R_PAREN' || type === 'RPAREN'; }

export interface BodyIndentEvent {
	token: SqlToken;
	governor: SqlToken;
	actualCol: number;
	expectedCol: number;
	range: vscode.Range;
	message: string;
	fix: { ops: FixOp[]; autoFix: boolean };
}

export function runBodyIndentEngine(
	ninjaSqlTokens: NinjaSqlToken[] | undefined,
	_document: vscode.TextDocument,
	config: NinjaConfig,
): BodyIndentEvent[] {
	const sqlTokens = sqlOnly(ninjaSqlTokens);
	if (sqlTokens.length === 0) return [];

	const indentSize = config.indentation.unit === 'tab' ? 1 : config.indentation.size;
	const events: BodyIndentEvent[] = [];

	// Lines whose first content is a jinja tag — skip to avoid clobbering
	// the jinja content with a leading-whitespace replacement.
	const jinjaLines = jinjaLeadingLines(ninjaSqlTokens);

	// Cache first-on-line lookups for O(1) anchor checks.
	const firstOnLine = new Map<number, SqlToken>();
	for (const tok of sqlTokens) {
		if (!firstOnLine.has(tok.line)) firstOnLine.set(tok.line, tok);
	}

	// Stack: index 0 = top level, push on L_PAREN. Each slot holds the most
	// recent clause keyword seen at that depth (undefined = no clause yet).
	const clauseStack: Array<SqlToken | undefined> = [undefined];

	for (const tok of sqlTokens) {
		const type = tok.type;

		if (isLParen(type)) {
			clauseStack.push(undefined);
			continue;
		}
		if (isRParen(type)) {
			if (clauseStack.length > 1) clauseStack.pop();
			continue;
		}

		// Update governor on clause keywords (this also falls through to the
		// anchor check — SKIP_ANCHOR_TYPES will exclude them from flagging).
		if (CLAUSE_KEYWORDS.has(type)) {
			clauseStack[clauseStack.length - 1] = tok;
		}

		// Skip lines whose first content is jinja — re-indenting would delete it.
		if (jinjaLines.has(tok.line)) continue;

		if (firstOnLine.get(tok.line) !== tok) continue;
		if (SKIP_ANCHOR_TYPES.has(type)) continue;

		const governor = clauseStack[clauseStack.length - 1];
		if (!governor) continue;              // no clause in scope yet
		if (governor.line === tok.line) continue; // inline statement

		const govCol = tokenStartCol(governor);
		const actualCol = tokenStartCol(tok);
		const expectedCol = govCol + indentSize;

		if (actualCol === expectedCol) continue;

		const line = tok.line;
		const range = new vscode.Range(line, 0, line, actualCol);
		const govLabel = governor.type.toLowerCase().replace(/_/g, ' ');
		const message = actualCol < expectedCol
			? `Clause-body token expected at column ${expectedCol} (one indent under '${govLabel}'); currently column ${actualCol}.`
			: `Clause-body token over-indented at column ${actualCol} (expected column ${expectedCol}, one indent under '${govLabel}').`;

		const indentText = config.indentation.unit === 'tab'
			? '\t'.repeat(Math.floor(expectedCol / indentSize))
			: ' '.repeat(expectedCol);

		events.push({
			token: tok,
			governor,
			actualCol,
			expectedCol,
			range,
			message,
			fix: { ops: [replaceOp(range, indentText)], autoFix: true },
		});
	}

	return events;
}
