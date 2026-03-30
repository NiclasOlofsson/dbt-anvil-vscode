/**
 * Utilities for detecting SQL and Jinja comments in text.
 * Handles:  -- line comments,  /* block comments * /,  {# Jinja comments #}
 * Correctly ignores comment markers inside SQL string literals.
 */

export interface CommentRange {
	start: number;
	end: number;
}

/**
 * Walk the full text once and return every comment range.
 * Handles nested/interleaved strings so that markers inside
 * string literals are never treated as comment boundaries.
 */
export function computeCommentRanges(text: string): CommentRange[] {
	const ranges: CommentRange[] = [];
	const len = text.length;
	let i = 0;

	while (i < len) {
		const ch = text[i];

		// --- String literal (skip contents) ---
		if (ch === '\'') {
			i++;
			while (i < len) {
				if (text[i] === '\'' && text[i + 1] === '\'') {
					i += 2; // escaped ''
				} else if (text[i] === '\'') {
					i++;
					break;
				} else {
					i++;
				}
			}
			continue;
		}

		// --- Line comment:  -- ---
		if (ch === '-' && text[i + 1] === '-') {
			const start = i;
			i += 2;
			while (i < len && text[i] !== '\n') i++;
			ranges.push({ start, end: i });
			continue;
		}

		// --- Block comment:  /* ... */ ---
		if (ch === '/' && text[i + 1] === '*') {
			const start = i;
			i += 2;
			while (i < len - 1 && !(text[i] === '*' && text[i + 1] === '/')) i++;
			i += 2; // skip */
			ranges.push({ start, end: i });
			continue;
		}

		// --- Jinja comment:  {# ... #} ---
		if (ch === '{' && text[i + 1] === '#') {
			const start = i;
			i += 2;
			while (i < len - 1 && !(text[i] === '#' && text[i + 1] === '}')) i++;
			i += 2; // skip #}
			ranges.push({ start, end: i });
			continue;
		}

		i++;
	}

	return ranges;
}

/**
 * Check whether the given offset falls inside any comment range.
 * Ranges must be sorted by start (which computeCommentRanges guarantees).
 * Uses binary search — O(log n) per call.
 */
export function isOffsetInComment(offset: number, ranges: CommentRange[]): boolean {
	let lo = 0;
	let hi = ranges.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >>> 1;
		const r = ranges[mid];
		if (offset < r.start) {
			hi = mid - 1;
		} else if (offset >= r.end) {
			lo = mid + 1;
		} else {
			return true;
		}
	}
	return false;
}

/**
 * Quick single-line check: is the character position after a `--` on this line?
 * Also detects `{# ... #}` on the same line.
 * Does NOT handle multi-line block comments — use computeCommentRanges for that.
 */
export function isLinePositionInComment(lineText: string, characterPos: number): boolean {
	let inString = false;
	for (let i = 0; i < lineText.length && i <= characterPos; i++) {
		const ch = lineText[i];
		if (ch === '\'' && !inString) {
			inString = true;
			continue;
		}
		if (ch === '\'' && inString) {
			if (lineText[i + 1] === '\'') { i++; continue; }
			inString = false;
			continue;
		}
		if (inString) continue;

		if (ch === '-' && lineText[i + 1] === '-') {
			return characterPos >= i;
		}
		if (ch === '{' && lineText[i + 1] === '#') {
			// Check if position is between {# and #}
			const endIdx = lineText.indexOf('#}', i + 2);
			if (endIdx === -1 || characterPos <= endIdx + 1) {
				return characterPos >= i;
			}
			i = endIdx + 1; // skip past #}
		}
	}
	return false;
}
