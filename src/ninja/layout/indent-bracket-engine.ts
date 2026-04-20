/**
 * Bracket-body indentation engine (Phase 2 of LT02 equivalent).
 *
 * Handles the content of `(...)` scopes — CTE bodies, subqueries, multi-line
 * function call args, multi-line `IN` lists. Anchors to the first content
 * token on the `(`'s line and expects content one indent level deeper.
 *
 * ## Handoff with indent-body
 * Once a clause keyword (SELECT/FROM/WHERE/...) is seen at a given paren
 * depth, this engine stops firing at that depth — `indent-body` owns the
 * content indent from there. This avoids any double-flagging between the
 * two rules.
 *
 * Peer rules (FROM peer of SELECT etc.) then keep subsequent clause
 * keywords at the inner SELECT's level, and indent-body places column /
 * condition lines one deeper.
 *
 * ## What still isn't touched
 * - `)` on its own line (should match opener's col, not opener + indent) —
 *   follow-up rule.
 * - Nested parens with no clause in either scope: anchors correctly cascade
 *   because each L_PAREN pushes a fresh scope.
 */

import * as vscode from 'vscode';
import type { SqlToken } from '../../ftl/parse-result';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import { sqlOnly, jinjaLeadingLines } from '../../ftl/ninja-sql-tokens';
import type { NinjaConfig } from '../config';
import { tokenStartCol } from '../fix-utils';
import { replaceOp, type FixOp } from '../fix-op';

/** Clause keywords — seeing one hands off further checking to indent-body. */
const CLAUSE_KEYWORDS: ReadonlySet<string> = new Set([
	'SELECT', 'FROM', 'WHERE', 'HAVING',
	'GROUP_BY', 'GROUP', 'ORDER_BY', 'ORDER',
	'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW',
]);

/**
 * Token types that should NOT trigger a bracket-body check even when first
 * on a line inside a paren scope. Mostly structural: parens/brackets, commas
 * (leading-comma style), operator continuations, dots.
 */
const SKIP_ANCHOR_TYPES: ReadonlySet<string> = new Set([
	'L_PAREN', 'LPAREN', 'R_PAREN', 'RPAREN',
	'L_BRACKET', 'LBRACKET', 'R_BRACKET', 'RBRACKET',
	'COMMA', 'SEMICOLON', 'DOT',
	'AND', 'OR', 'NOT',
]);

function isLParen(type: string) { return type === 'L_PAREN' || type === 'LPAREN'; }
function isRParen(type: string) { return type === 'R_PAREN' || type === 'RPAREN'; }

export interface BracketIndentEvent {
	token: SqlToken;
	actualCol: number;
	expectedCol: number;
	range: vscode.Range;
	message: string;
	fix: { ops: FixOp[]; autoFix: boolean };
}

interface ParenScope {
	/** Line of the `(` that opened this scope. */
	parenLine: number;
	/** Column of the first content token on the `(`'s line. */
	anchorCol: number;
	/** True once we've seen a clause keyword inside this scope — hands off to indent-body. */
	clauseSeen: boolean;
}

export function runBracketIndentEngine(
	ninjaSqlTokens: NinjaSqlToken[] | undefined,
	_document: vscode.TextDocument,
	config: NinjaConfig,
): BracketIndentEvent[] {
	const sqlTokens = sqlOnly(ninjaSqlTokens);
	if (sqlTokens.length === 0) return [];

	const indentSize = config.indentation.unit === 'tab' ? 1 : config.indentation.size;
	const events: BracketIndentEvent[] = [];

	// Lines whose first content is jinja — skip to avoid wiping the jinja
	// tag with a leading-whitespace replacement.
	const jinjaLines = jinjaLeadingLines(ninjaSqlTokens);

	const firstOnLine = new Map<number, SqlToken>();
	for (const tok of sqlTokens) {
		if (!firstOnLine.has(tok.line)) firstOnLine.set(tok.line, tok);
	}

	const parenStack: ParenScope[] = [];

	for (const tok of sqlTokens) {
		const type = tok.type;

		if (isLParen(type)) {
			const opener = firstOnLine.get(tok.line) ?? tok;
			parenStack.push({
				parenLine: tok.line,
				anchorCol: tokenStartCol(opener),
				clauseSeen: false,
			});
			continue;
		}
		if (isRParen(type)) {
			if (parenStack.length > 0) parenStack.pop();
			continue;
		}
		if (parenStack.length === 0) continue; // nothing to do at top level

		const scope = parenStack[parenStack.length - 1];

		// Once a clause keyword is seen, indent-body takes over for this scope.
		if (scope.clauseSeen) {
			if (CLAUSE_KEYWORDS.has(type)) continue; // still on a clause, no-op
			continue;
		}

		// We still haven't seen a clause keyword. Process this token —
		// flagging will only happen for first-on-line, non-skip tokens.
		const isClause = CLAUSE_KEYWORDS.has(type);
		const anchor = firstOnLine.get(tok.line);
		const isFirstOnLine = anchor === tok;

		// Always flip clauseSeen for any clause keyword we encounter, even if
		// it was on the `(`'s line — the clause is now active at this depth.
		if (isClause) scope.clauseSeen = true;

		if (!isFirstOnLine) continue;
		if (SKIP_ANCHOR_TYPES.has(type)) continue;
		if (scope.parenLine === tok.line) continue; // content on opener's line
		if (jinjaLines.has(tok.line)) continue;     // jinja-leading line: don't clobber the tag

		const expectedCol = scope.anchorCol + indentSize;
		const actualCol = tokenStartCol(tok);
		if (actualCol === expectedCol) continue;

		const line = tok.line;
		const range = new vscode.Range(line, 0, line, actualCol);
		const message = actualCol < expectedCol
			? `Bracket body expected at column ${expectedCol} (one indent under the opening bracket); currently column ${actualCol}.`
			: `Bracket body over-indented at column ${actualCol} (expected column ${expectedCol}, one indent under the opening bracket).`;

		const indentText = config.indentation.unit === 'tab'
			? '\t'.repeat(Math.floor(expectedCol / indentSize))
			: ' '.repeat(expectedCol);

		events.push({
			token: tok,
			actualCol,
			expectedCol,
			range,
			message,
			fix: { ops: [replaceOp(range, indentText)], autoFix: true },
		});
	}

	return events;
}
