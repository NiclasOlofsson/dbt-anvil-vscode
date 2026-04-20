/**
 * Tokenize jinja tags into a flat stream of fine-grained tokens.
 *
 * Reuses `iterJinjaTags()` (the depth-counting tag scanner from
 * jinja-blanker.ts) to find tag boundaries, then walks the inner content of
 * each tag to emit one token per syntactic element: braces, identifiers,
 * strings, parens, commas, dots, numbers, raw text.
 *
 * The output is interleavable with `SqlToken[]` from sqlglot — every token
 * carries `start`, `end`, `line`, `col` in raw-source coordinates.
 *
 * No regex (other than the small character-class probes); no Pyodide; no AST.
 */
import { iterJinjaTags } from '../dbt/jinja-blanker';
import { buildLineStarts, colAtOffset, lineAtOffset } from './jinja-spans';

export type JinjaTokenType =
	| 'jinja_expression_open'  // {{
	| 'jinja_expression_close' // }}
	| 'jinja_block_open'       // {%
	| 'jinja_block_close'      // %}
	| 'jinja_comment_open'     // {#
	| 'jinja_comment_close'    // #}
	| 'jinja_identifier'       // ref, source, my_macro, var, if, for, in, etc.
	| 'jinja_string'           // 'my_model' or "my_model" (value excludes quotes)
	| 'jinja_number'           // 42, 3.14
	| 'jinja_paren_open'       // (
	| 'jinja_paren_close'      // )
	| 'jinja_comma'            // ,
	| 'jinja_dot'              // .  (e.g. dbt_utils.macro)
	| 'jinja_operator'         // |, =, ==, !=, -, +, *, /, etc. — coalesced operator runs
	| 'jinja_text';            // genuine opaque body content (currently: comment bodies)

export interface JinjaToken {
	type: JinjaTokenType;
	/** 0-based start offset in the raw source. */
	start: number;
	/** 0-based exclusive end offset in the raw source. */
	end: number;
	/** 0-based line of the start offset. */
	line: number;
	/** 0-based column of the start offset. */
	col: number;
	/**
	 * Token text content. For strings, the surrounding quotes are excluded
	 * (use `start`/`end` to recover the quoted span). For other tokens, the
	 * value is the literal text from the source.
	 */
	value: string;
	/**
	 * On `*_open` tokens only: 0-based exclusive end offset of the matching
	 * close (e.g. for `{{`, the offset just past the matching `}}`). Lets
	 * consumers walking the merged stream skip an entire jinja region in O(1)
	 * without scanning forward for the close.
	 */
	tagEnd?: number;
}

/**
 * Walk the source and emit a flat jinja token stream.
 *
 * Expression tags `{{ ... }}` and block tags `{% ... %}` share the same
 * inner-tokenization logic — both bodies contain jinja expressions/statements
 * that benefit from being broken into identifiers, strings, operators, etc.
 * Comment tags `{# ... #}` are emitted as a single opaque `jinja_text` body
 * since their content is by definition meaningless to the template engine.
 */
export function tokenizeJinja(sql: string): JinjaToken[] {
	const lineStarts = buildLineStarts(sql);
	const tokens: JinjaToken[] = [];

	const emit = (type: JinjaTokenType, start: number, end: number, value: string, tagEnd?: number): void => {
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

type Emit = (type: JinjaTokenType, start: number, end: number, value: string, tagEnd?: number) => void;

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

/**
 * Tokenize a tag whose body holds jinja syntax (expressions or statements).
 * Used for both `{{ ... }}` and `{% ... %}` — they share inner grammar
 * (identifiers, strings, operators, parens, commas, dots, numbers).
 *
 * Whitespace-control hyphens ({{- ... -}}) sit at the inside edges and fall
 * out as `jinja_operator` tokens since they are operator-class punctuation.
 */
function tokenizeStructuredTag(
	tag: string,
	tagStart: number,
	tagEnd: number,
	openType: JinjaTokenType,
	closeType: JinjaTokenType,
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

/**
 * Tokenize a tag whose body is opaque to the template engine (comments).
 * Emits open + (optional whitespace-trimmed) text body + close.
 */
function tokenizeOpaqueTag(
	tag: string,
	tagStart: number,
	tagEnd: number,
	openType: JinjaTokenType,
	closeType: JinjaTokenType,
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
