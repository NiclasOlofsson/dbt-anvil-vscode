/**
 * FROZEN REFERENCE IMPLEMENTATIONS — test oracles only, never production code.
 *
 * These are the extension's two retired hand-written jinja scanners, moved here
 * verbatim when production switched to sqllens's templated front end:
 *   - `referenceTokenizeJinja` — the fine-grained stream scanner (was
 *     src/ftl/jinja-tokenizer.ts + iterJinjaTags from src/dbt/jinja-blanker.ts).
 *     Oracle for the jinja-stream parity suite.
 *   - `referenceCoarseTokenize` — the coarse per-tag scanner (was
 *     src/dbt/jinja-tokenizer.ts). Oracle for the coarse-jinja parity suite.
 *
 * They exist so the parity suites keep an INDEPENDENT implementation to diff
 * the live sqllens-fed adapters against. Do not "fix" behavior here — a
 * divergence from these is either a live-path regression or a documented,
 * deliberate improvement pinned in the parity tests.
 */
import type { JinjaToken as FineJinjaToken, JinjaTokenType as FineJinjaTokenType } from '../../ftl/jinja-tokenizer';
import type { JinjaToken as CoarseJinjaToken } from '../../ftl/sqllens/extract/coarse-jinja';
import { buildLineStarts, colAtOffset, lineAtOffset } from '../../ftl/line-index';

// ---------------------------------------------------------------------------
// iterJinjaTags — the depth-counting tag scanner (ex src/dbt/jinja-blanker.ts).
// ---------------------------------------------------------------------------

interface JinjaTagMatch {
	index: number;
	0: string; // full tag text — keeps the same shape as a RegExpMatchArray
}

function* iterJinjaTags(sql: string): Generator<JinjaTagMatch> {
	const n = sql.length;
	let i = 0;
	while (i < n) {
		if (sql[i] !== '{' || i + 1 >= n) { i++; continue; }
		const next = sql[i + 1];

		if (next === '{') {
			// Depth-count {{ / }} pairs to find the matching close.
			const start = i;
			let depth = 0;
			let j = i;
			while (j < n) {
				if (sql[j] === '{' && j + 1 < n && sql[j + 1] === '{') {
					depth++; j += 2;
				} else if (sql[j] === '}' && j + 1 < n && sql[j + 1] === '}') {
					depth--; j += 2;
					if (depth === 0) break;
				} else {
					j++;
				}
			}
			if (depth === 0) yield { index: start, 0: sql.slice(start, j) };
			i = j;

		} else if (next === '%') {
			const start = i;
			const end = sql.indexOf('%}', i + 2);
			if (end === -1) break;
			const j = end + 2;
			yield { index: start, 0: sql.slice(start, j) };
			i = j;

		} else if (next === '#') {
			const start = i;
			const end = sql.indexOf('#}', i + 2);
			if (end === -1) break;
			const j = end + 2;
			yield { index: start, 0: sql.slice(start, j) };
			i = j;

		} else {
			i++;
		}
	}
}

// ---------------------------------------------------------------------------
// referenceTokenizeJinja — the fine-grained scanner (ex src/ftl/jinja-tokenizer.ts).
// ---------------------------------------------------------------------------

export function referenceTokenizeJinja(sql: string): FineJinjaToken[] {
	const lineStarts = buildLineStarts(sql);
	const tokens: FineJinjaToken[] = [];

	const emit = (type: FineJinjaTokenType, start: number, end: number, value: string, tagEnd?: number): void => {
		tokens.push({
			type,
			start,
			end,
			line: lineAtOffset(start, lineStarts),
			col: colAtOffset(start, lineStarts),
			value,
			...(tagEnd !== undefined ? { tagEnd } : {}),
		});
	};

	for (const match of iterJinjaTags(sql)) {
		const tag = match[0];
		const tagStart = match.index;
		const tagEnd = tagStart + tag.length;

		if (tag.startsWith('{{') && tag.endsWith('}}')) {
			tokenizeStructuredTag(tag, tagStart, tagEnd, 'jinja_expression_open', 'jinja_expression_close', emit);
		} else if (tag.startsWith('{%') && tag.endsWith('%}')) {
			tokenizeStructuredTag(tag, tagStart, tagEnd, 'jinja_block_open', 'jinja_block_close', emit);
		} else if (tag.startsWith('{#') && tag.endsWith('#}')) {
			tokenizeOpaqueTag(tag, tagStart, tagEnd, 'jinja_comment_open', 'jinja_comment_close', emit);
		}
	}

	return tokens;
}

type Emit = (type: FineJinjaTokenType, start: number, end: number, value: string, tagEnd?: number) => void;

function isIdentStart(ch: string): boolean {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}
function isIdentPart(ch: string): boolean {
	return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}
function isDigit(ch: string): boolean {
	return ch >= '0' && ch <= '9';
}
function isWs(ch: string): boolean {
	return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function tokenizeStructuredTag(
	tag: string,
	tagStart: number,
	tagEnd: number,
	openType: FineJinjaTokenType,
	closeType: FineJinjaTokenType,
	emit: Emit,
): void {
	emit(openType, tagStart, tagStart + 2, tag.slice(0, 2), tagEnd);

	let i = 2;
	const innerEnd = tag.length - 2;

	while (i < innerEnd) {
		const ch = tag[i];

		if (isWs(ch)) { i++; continue; }

		if (ch === '\'' || ch === '"') {
			const quote = ch;
			const start = i;
			i++; // past opening quote
			while (i < innerEnd && tag[i] !== quote) {
				if (tag[i] === '\\' && i + 1 < innerEnd) i++; // skip escaped char
				i++;
			}
			const closed = i < innerEnd;
			const valueEnd = i; // position of closing quote (or innerEnd if unclosed)
			const end = closed ? i + 1 : innerEnd;
			emit('jinja_string', tagStart + start, tagStart + end, tag.slice(start + 1, valueEnd));
			i = end;
			continue;
		}

		if (isIdentStart(ch)) {
			const start = i;
			while (i < innerEnd && isIdentPart(tag[i])) i++;
			emit('jinja_identifier', tagStart + start, tagStart + i, tag.slice(start, i));
			continue;
		}

		if (isDigit(ch)) {
			const start = i;
			while (i < innerEnd && (isDigit(tag[i]) || tag[i] === '.')) i++;
			emit('jinja_number', tagStart + start, tagStart + i, tag.slice(start, i));
			continue;
		}

		if (ch === '(') { emit('jinja_paren_open', tagStart + i, tagStart + i + 1, '('); i++; continue; }
		if (ch === ')') { emit('jinja_paren_close', tagStart + i, tagStart + i + 1, ')'); i++; continue; }
		if (ch === ',') { emit('jinja_comma', tagStart + i, tagStart + i + 1, ','); i++; continue; }
		if (ch === '.') { emit('jinja_dot', tagStart + i, tagStart + i + 1, '.'); i++; continue; }

		// Anything else (|, =, ==, !=, +, -, *, /, etc.): coalesce into one operator run.
		const start = i;
		while (i < innerEnd) {
			const c = tag[i];
			if (isWs(c) || c === '\'' || c === '"' || isIdentStart(c) || isDigit(c)
				|| c === '(' || c === ')' || c === ',' || c === '.') break;
			i++;
		}
		if (i > start) {
			emit('jinja_operator', tagStart + start, tagStart + i, tag.slice(start, i));
		} else {
			i++; // safety — should not happen
		}
	}

	emit(closeType, tagEnd - 2, tagEnd, tag.slice(tag.length - 2));
}

function tokenizeOpaqueTag(
	tag: string,
	tagStart: number,
	tagEnd: number,
	openType: FineJinjaTokenType,
	closeType: FineJinjaTokenType,
	emit: Emit,
): void {
	emit(openType, tagStart, tagStart + 2, tag.slice(0, 2), tagEnd);

	let i = 2;
	const innerEnd = tag.length - 2;
	while (i < innerEnd && isWs(tag[i])) i++;
	let j = innerEnd;
	while (j > i && isWs(tag[j - 1])) j--;
	if (j > i) {
		emit('jinja_text', tagStart + i, tagStart + j, tag.slice(i, j));
	}

	emit(closeType, tagEnd - 2, tagEnd, tag.slice(tag.length - 2));
}

// ---------------------------------------------------------------------------
// referenceCoarseTokenize — the coarse scanner (ex src/dbt/jinja-tokenizer.ts).
// ---------------------------------------------------------------------------

export function referenceCoarseTokenize(source: string): CoarseJinjaToken[] {
	const tokens: CoarseJinjaToken[] = [];
	const len = source.length;
	let i = 0;
	let textStart = 0;

	const flushText = (end: number): void => {
		if (end > textStart) {
			tokens.push({
				type: 'text',
				content: source.slice(textStart, end),
				raw: source.slice(textStart, end),
				start: textStart,
				end,
			});
		}
		textStart = end;
	};

	while (i < len) {
		// Skip SQL -- line comments: advance to end of line without looking for Jinja.
		if (source[i] === '-' && source[i + 1] === '-') {
			const nl = source.indexOf('\n', i);
			i = nl === -1 ? len : nl + 1;
			continue;
		}

		if (source[i] !== '{') {
			i++;
			continue;
		}

		const next = source[i + 1];
		if (next !== '{' && next !== '%' && next !== '#') {
			i++;
			continue;
		}

		// Flush preceding text
		flushText(i);

		const tokenStart = i;

		if (next === '{') {
			// Expression: {{ ... }} or {{- ... -}}
			i += 2; // skip {{
			const contentStart = i;
			while (i < len) {
				if (source[i] === '}' && source[i + 1] === '}') {
					i += 2; // skip }}
					break;
				}
				i = advancePastChar(source, i);
			}
			const raw = source.slice(tokenStart, i);
			tokens.push({
				type: 'expression',
				content: source.slice(contentStart, i - 2),
				raw,
				start: tokenStart,
				end: i,
			});
		} else if (next === '%') {
			// Tag: {% ... %} or {%- ... -%}
			i += 2; // skip {%
			const contentStart = i;
			while (i < len) {
				if (source[i] === '%' && source[i + 1] === '}') {
					i += 2; // skip %}
					break;
				}
				i = advancePastChar(source, i);
			}
			const raw = source.slice(tokenStart, i);
			tokens.push({
				type: 'tag',
				content: source.slice(contentStart, i - 2),
				raw,
				start: tokenStart,
				end: i,
			});
		} else {
			// Comment: {# ... #} or {#- ... -#}
			i += 2; // skip {#
			const contentStart = i;
			while (i < len) {
				if (source[i] === '#' && source[i + 1] === '}') {
					i += 2; // skip #}
					break;
				}
				i++; // no string literals inside comments
			}
			const raw = source.slice(tokenStart, i);
			tokens.push({
				type: 'comment',
				content: source.slice(contentStart, i - 2),
				raw,
				start: tokenStart,
				end: i,
			});
		}

		textStart = i;
	}

	// Flush trailing text
	flushText(len);

	return tokens;
}

function advancePastChar(source: string, i: number): number {
	const ch = source[i];
	if (ch === '"' || ch === '\'') {
		// Scan until closing quote, respecting backslash escapes
		const quote = ch;
		i++;
		while (i < source.length) {
			if (source[i] === '\\') {
				i += 2; // skip escaped char
				continue;
			}
			if (source[i] === quote) {
				i++; // skip closing quote
				break;
			}
			i++;
		}
		return i;
	}
	return i + 1;
}
