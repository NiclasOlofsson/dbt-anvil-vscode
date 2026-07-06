import type { SqlToken } from '../ftl/sql-tokens';

/**
 * Returns the last SQL token on the given 0-based line, or undefined if none.
 *
 * Comments are not standalone tokens — they are attached to adjacent
 * tokens via `token.comments`. So every token in sqlTokens is a content token
 * and `.col` reflects the token's own end, before any trailing comment text.
 *
 * Use `.col` of the returned token as the insert column when appending to a line
 * (0-based exclusive end column).
 */
export function lastContentTokenOnLine(tokens: SqlToken[], line: number): SqlToken | undefined {
	let result: SqlToken | undefined;
	for (const t of tokens) {
		if (t.line === line) result = t;
		else if (t.line > line) break;
	}
	return result;
}

/**
 * Returns the first SQL token on the given 0-based line, or undefined if none.
 *
 * Use `tokenStartCol()` of the returned token as the insert column when prepending
 * to a line (positions at the start of the first content token, not at string pos 0).
 */
export function firstContentTokenOnLine(tokens: SqlToken[], line: number): SqlToken | undefined {
	for (const t of tokens) {
		if (t.line === line) return t;
		if (t.line > line) return undefined;
	}
	return undefined;
}

/**
 * Returns the 0-based start column of a token.
 *
 * SqlToken.col is the 1-based end column (= 0-based exclusive end).
 * The token spans exactly `end - start + 1` characters on its line.
 * Therefore: startCol = col - (end - start + 1)
 */
export function tokenStartCol(token: SqlToken): number {
	return token.col - (token.end - token.start + 1);
}
