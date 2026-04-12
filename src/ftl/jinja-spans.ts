/**
 * Extract Jinja ref() / source() span information from raw dbt SQL.
 *
 * All positions are in raw-source space (0-based lines, 0-based cols).
 * The extractor works entirely on the raw SQL string — no Pyodide, no regex.
 * Tag boundaries are found by iterJinjaTags (char-by-char depth counter);
 * argument content is parsed with plain string operations.
 */
import { iterJinjaTags } from '../dbt/jinja-blanker';
import type { JinjaRefSpan, JinjaSourceSpan, JinjaTagSpan } from './parse-result';

// ---------------------------------------------------------------------------
// Offset ↔ line/col helpers
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Tag argument parser (no regex)
// ---------------------------------------------------------------------------

/** Advance i past ASCII spaces and tabs. */
function skipWs(s: string, i: number): number {
	while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
	return i;
}

/**
 * Read a single- or double-quoted string starting at position i (which must
 * point at the opening quote character).  Returns the unquoted value and the
 * relative positions of the content (relStart = first char after opening quote,
 * relEnd = position of the closing quote).
 */
function readQuoted(s: string, i: number): { value: string; relStart: number; relEnd: number } | undefined {
	const q = s[i];
	if (q !== '\'' && q !== '"') return undefined;
	const start = i + 1;
	const end = s.indexOf(q, start);
	if (end === -1) return undefined;
	return { value: s.slice(start, end), relStart: start, relEnd: end };
}

// ---------------------------------------------------------------------------
// Per-tag parsers
// ---------------------------------------------------------------------------

function tryParseRef(tag: string, tagStart: number, lineStarts: number[]): JinjaRefSpan | undefined {
	const refIdx = tag.indexOf('ref(');
	if (refIdx === -1) return undefined;

	let i = skipWs(tag, refIdx + 4); // past 'ref('
	const arg = readQuoted(tag, i);
	if (!arg) return undefined;

	// Closing ')' must follow immediately after the quoted arg (guards against
	// matching 'ref(' inside a source() or arbitrary macro call).
	const j = skipWs(tag, arg.relEnd + 1); // past closing quote
	if (tag[j] !== ')') return undefined;

	const callAbsOffset = tagStart + refIdx;
	const line = lineAtOffset(callAbsOffset, lineStarts);

	return {
		type: 'ref',
		line,
		col: colAtOffset(callAbsOffset, lineStarts),
		model: arg.value,
		modelCol: colAtOffset(tagStart + arg.relStart, lineStarts),
		modelEndCol: colAtOffset(tagStart + arg.relEnd, lineStarts),
		jinjaCol: colAtOffset(tagStart, lineStarts),
		jinjaEndCol: colAtOffset(tagStart + tag.length, lineStarts),
	};
}

function tryParseSource(tag: string, tagStart: number, lineStarts: number[]): JinjaSourceSpan | undefined {
	const srcIdx = tag.indexOf('source(');
	if (srcIdx === -1) return undefined;

	let i = skipWs(tag, srcIdx + 7); // past 'source('
	const arg1 = readQuoted(tag, i);
	if (!arg1) return undefined;

	i = skipWs(tag, arg1.relEnd + 1); // past closing quote of first arg
	if (tag[i] !== ',') return undefined;
	i = skipWs(tag, i + 1); // past comma

	const arg2 = readQuoted(tag, i);
	if (!arg2) return undefined;

	const j = skipWs(tag, arg2.relEnd + 1); // past closing quote of second arg
	if (tag[j] !== ')') return undefined;

	const callAbsOffset = tagStart + srcIdx;
	const line = lineAtOffset(callAbsOffset, lineStarts);

	return {
		type: 'source',
		line,
		col: colAtOffset(callAbsOffset, lineStarts),
		sourceName: arg1.value,
		tableName: arg2.value,
		sourceNameCol: colAtOffset(tagStart + arg1.relStart, lineStarts),
		sourceNameEndCol: colAtOffset(tagStart + arg1.relEnd, lineStarts),
		tableNameCol: colAtOffset(tagStart + arg2.relStart, lineStarts),
		tableNameEndCol: colAtOffset(tagStart + arg2.relEnd, lineStarts),
		jinjaCol: colAtOffset(tagStart, lineStarts),
		jinjaEndCol: colAtOffset(tagStart + tag.length, lineStarts),
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Scan raw dbt SQL for `{{ ref(...) }}` and `{{ source(..., ...) }}` tags and
 * return precise position information for each one.
 *
 * Works on the original (un-blanked) source string so all positions are in
 * raw-source space.  No Pyodide required.
 */
export function extractJinjaSpans(sql: string): JinjaTagSpan[] {
	const lineStarts = buildLineStarts(sql);
	const spans: JinjaTagSpan[] = [];

	for (const match of iterJinjaTags(sql)) {
		const tag = match[0];
		if (!tag.startsWith('{{')) continue; // skip {% %} and {# #}
		const tagStart = match.index;

		// Try ref first; source() does not contain the substring 'ref('.
		const ref = tryParseRef(tag, tagStart, lineStarts);
		if (ref) { spans.push(ref); continue; }

		const src = tryParseSource(tag, tagStart, lineStarts);
		if (src) spans.push(src);
	}

	return spans;
}
