import { blankJinja } from './jinja-blanker';

/**
 * A single SQL statement extracted from a multi-statement document.
 * Offsets refer to the original (un-blanked) source text.
 */
export interface StatementRange {
	/** The original SQL text of this statement (trimmed, no trailing `;`). */
	sql: string;
	/** 0-based line number of the first non-whitespace character. */
	startLine: number;
	/** 0-based line number of the last non-whitespace character. */
	endLine: number;
	/** 0-based character offset into the full document where the statement starts. */
	startOffset: number;
	/** 0-based character offset into the full document where the statement ends (exclusive of `;`). */
	endOffset: number;
}

/**
 * Split a Jinja-SQL document into individual statements separated by `;`.
 *
 * Strategy:
 * 1. Use `blankJinja()` to neutralise all Jinja tags (preserving offsets).
 * 2. Walk the blanked text, tracking string literals (`'...'`) and comments
 *    (`--` line, `/ * … * /` block) so we only split on `;` that is actually
 *    statement-terminating.
 * 3. Map split points back to the original source via the preserved offsets.
 *
 * Empty statements (e.g. `;;` or trailing `;`) are discarded.
 */
// Matches all Jinja tag types — same pattern as jinja-blanker.ts.
// Duplicated here to avoid exporting an internal regex.
const JINJA_RE = /\{%-?[\s\S]*?-?%\}|\{\{[\s\S]*?\}\}|\{#-?[\s\S]*?-?#\}/g;

export function splitStatements(sql: string): StatementRange[] {
	const { blanked } = blankJinja(sql);
	const len = blanked.length;
	const splitPoints: number[] = [];

	// Build a set of positions that fall inside Jinja tags in the original text.
	// blankJinja() may leave special chars (like `;` in an identifier) that we
	// must NOT treat as statement terminators.
	const insideJinja = new Uint8Array(len);
	for (const m of sql.matchAll(JINJA_RE)) {
		const start = m.index!;
		const end = start + m[0].length;
		for (let j = start; j < end; j++) insideJinja[j] = 1;
	}

	let i = 0;
	while (i < len) {
		const ch = blanked[i];

		// Single-quoted string literal — skip to closing quote
		if (ch === '\'') {
			i++;
			while (i < len) {
				if (blanked[i] === '\'') {
					if (i + 1 < len && blanked[i + 1] === '\'') {
						i += 2; // escaped ''
					} else {
						i++;
						break;
					}
				} else {
					i++;
				}
			}
			continue;
		}

		// Line comment -- skip to end of line
		if (ch === '-' && i + 1 < len && blanked[i + 1] === '-') {
			i += 2;
			while (i < len && blanked[i] !== '\n') i++;
			continue;
		}

		// Block comment /* ... */ — skip to closing */
		if (ch === '/' && i + 1 < len && blanked[i + 1] === '*') {
			i += 2;
			while (i < len) {
				if (blanked[i] === '*' && i + 1 < len && blanked[i + 1] === '/') {
					i += 2;
					break;
				}
				i++;
			}
			continue;
		}

		// Statement terminator (only if not inside a Jinja tag region)
		if (ch === ';' && !insideJinja[i]) {
			splitPoints.push(i);
			i++;
			continue;
		}

		i++;
	}

	// Build ranges from split points.
	// Segments are: [0..split[0]), [split[0]+1..split[1]), ..., [lastSplit+1..end)
	const segments: Array<[number, number]> = [];
	let start = 0;
	for (const sp of splitPoints) {
		segments.push([start, sp]);
		start = sp + 1;
	}
	// Remainder after last `;` (or entire text if no `;`)
	segments.push([start, len]);

	const results: StatementRange[] = [];
	for (const [segStart, segEnd] of segments) {
		const raw = sql.slice(segStart, segEnd);
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;

		// Find the first and last non-whitespace character offsets in the original
		let firstNonWs = segStart;
		while (firstNonWs < segEnd && /\s/.test(sql[firstNonWs])) firstNonWs++;
		let lastNonWs = segEnd - 1;
		while (lastNonWs > firstNonWs && /\s/.test(sql[lastNonWs])) lastNonWs--;

		results.push({
			sql: trimmed,
			startLine: lineAt(sql, firstNonWs),
			endLine: lineAt(sql, lastNonWs),
			startOffset: firstNonWs,
			endOffset: lastNonWs + 1,
		});
	}

	return results;
}

/**
 * Given a list of statement ranges and a character offset (e.g. cursor position),
 * return the statement that contains that offset, or undefined if the offset
 * falls in whitespace/separator between statements.
 */
export function findStatementAtOffset(statements: StatementRange[], offset: number): StatementRange | undefined {
	for (const stmt of statements) {
		if (offset >= stmt.startOffset && offset < stmt.endOffset) {
			return stmt;
		}
	}
	// Offset is in whitespace — find the nearest statement.
	// Prefer the statement whose range is closest.
	let closest: StatementRange | undefined;
	let minDist = Infinity;
	for (const stmt of statements) {
		const dist = offset < stmt.startOffset
			? stmt.startOffset - offset
			: offset - stmt.endOffset;
		if (dist < minDist) {
			minDist = dist;
			closest = stmt;
		}
	}
	return closest;
}

/** Return the 0-based line number for a character offset in `text`. */
function lineAt(text: string, offset: number): number {
	let line = 0;
	for (let i = 0; i < offset && i < text.length; i++) {
		if (text[i] === '\n') line++;
	}
	return line;
}
