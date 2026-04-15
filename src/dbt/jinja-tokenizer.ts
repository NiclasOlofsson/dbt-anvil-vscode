export type JinjaTokenType = 'text' | 'expression' | 'tag' | 'comment';

export interface JinjaToken {
	type: JinjaTokenType;
	/** Inner content with delimiters stripped, whitespace-control dashes included if present. */
	content: string;
	/** Original source text including delimiters. */
	raw: string;
	/** Inclusive start offset in the source string. */
	start: number;
	/** Exclusive end offset in the source string. */
	end: number;
}

/**
 * Splits a Jinja2/SQL document into typed tokens with precise character offsets.
 *
 * Token types:
 *   'text'       — plain text between Jinja2 constructs
 *   'expression' — {{ ... }} (including {{- -}} variants)
 *   'tag'        — {% ... %} (including {%- -%} variants)
 *   'comment'    — {# ... #} (including {#- -#} variants)
 *
 * Handles string literals inside tags/expressions so that %}, }}, or #}
 * appearing inside a quoted string do not prematurely close the token.
 */
export function tokenize(source: string): JinjaToken[] {
	const tokens: JinjaToken[] = [];
	const len = source.length;
	let i = 0;
	let textStart = 0;

	const flushText = (end: number) => {
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

/**
 * Advance one logical "unit" past the current position, respecting string
 * literals so that closing delimiters inside quotes are not treated as token ends.
 * Returns the new position.
 */
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

/**
 * Returns the tag keyword (first word) from a 'tag' token's content.
 * Strips leading whitespace-control dash if present.
 *
 * Examples:
 *   {% if x %}        → 'if'
 *   {%- for item in list -%}  → 'for'
 *   {% endmacro %}    → 'endmacro'
 */
export function getTagName(token: JinjaToken): string | undefined {
	if (token.type !== 'tag') return undefined;
	// Strip leading whitespace and optional whitespace-control dash
	const trimmed = token.content.trimStart().replace(/^-\s*/, '');
	const match = trimmed.match(/^([a-zA-Z_]\w*)/);
	return match ? match[1] : undefined;
}
