import * as vscode from 'vscode';
import type { SqlToken } from '../ftl/sql-tokens';

/**
 * The absolute char offset of the first character on a given (0-based) line.
 * Identical helper exists as a local copy in several rules — this is the canonical version.
 */
export function lineOffset(text: string, line: number): number {
	let offset = 0;
	for (let i = 0; i < line; i++) {
		const nl = text.indexOf('\n', offset);
		if (nl === -1) return offset;
		offset = nl + 1;
	}
	return offset;
}

/** The raw source text of a SqlToken (inclusive of both endpoints). */
export function tokenText(text: string, token: SqlToken): string {
	return text.slice(token.start, token.end + 1);
}

/** The vscode.Range that spans exactly the SqlToken's source text. */
export function tokenRange(text: string, token: SqlToken): vscode.Range {
	const lo = lineOffset(text, token.line);
	return new vscode.Range(token.line, token.start - lo, token.line, token.end + 1 - lo);
}

/** Convert an absolute char offset into `{ line, col }` (both 0-based). */
export function offsetToLineCol(text: string, charOffset: number): { line: number; col: number } {
	let line = 0;
	let lastNewline = -1;
	const stop = Math.min(charOffset, text.length);
	for (let i = 0; i < stop; i++) {
		if (text[i] === '\n') { line++; lastNewline = i; }
	}
	return { line, col: charOffset - lastNewline - 1 };
}
