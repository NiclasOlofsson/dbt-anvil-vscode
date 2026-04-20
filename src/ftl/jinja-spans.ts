/**
 * Position helpers — offset ↔ line/col conversion in raw-source space.
 *
 * Originally part of a larger jinja-span extractor; what remains is the
 * thin offset math used by the jinja tokenizer, the CTE extractor, and the
 * debug-symbol emitter.
 */

/** Build an array where lineStarts[n] = offset of the first char on line n. */
export function buildLineStarts(sql: string): number[] {
	const starts = [0];
	for (let i = 0; i < sql.length; i++) {
		if (sql[i] === '\n') starts.push(i + 1);
	}
	return starts;
}

/** 0-based line index for the given offset (binary search on lineStarts). */
export function lineAtOffset(offset: number, lineStarts: number[]): number {
	let lo = 0;
	let hi = lineStarts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (lineStarts[mid] <= offset) lo = mid;
		else hi = mid - 1;
	}
	return lo;
}

/** 0-based column for the given offset. */
export function colAtOffset(offset: number, lineStarts: number[]): number {
	return offset - lineStarts[lineAtOffset(offset, lineStarts)];
}
