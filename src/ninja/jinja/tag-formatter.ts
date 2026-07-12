/**
 * Pure utility: normalise spacing inside a single jinja tag raw string.
 *
 * No VS Code dependency — operates on plain strings so it can be unit-tested
 * directly and reused anywhere that has the tag text.
 */

/**
 * Normalise spacing inside a jinja tag raw string.
 *
 * Rules applied:
 *   1. Single space after opening delimiter (accounting for whitespace-control dashes).
 *   2. Single space before closing delimiter (accounting for whitespace-control dashes).
 *   3. Single space after each comma inside function arguments (outside string literals).
 *   4. No spaces around `=` in keyword arguments (outside string literals).
 *
 * Returns the normalised string, or null if no changes are needed (identity check).
 * Never modifies content inside string literals (single or double quoted).
 * Multiline tags are returned unchanged — newlines inside a tag are intentional.
 */
export function normaliseTagSpacing(raw: string): string | null {
	// Only handle {{ }} and {% %} tags. Comments {# #} are skipped.
	if (raw.startsWith('{{') && raw.endsWith('}}')) {
		return normaliseStructuredTag(raw, '{{', '}}');
	}
	if (raw.startsWith('{%') && raw.endsWith('%}')) {
		return normaliseStructuredTag(raw, '{%', '%}');
	}
	return null;
}

/**
 * Normalise ONLY argument spacing inside a jinja tag: a single space after each
 * comma and no spaces around a kwarg `=`, both outside string literals. The
 * delimiter padding is left exactly as-is (that is `ninja.jinja.padding`'s
 * concern), so the two rules never overlap. Newline-aware: author line breaks
 * and indentation are preserved, and a comma at end of line gets no trailing
 * space because the break already separates the arguments.
 *
 * Returns the normalised string, or null if no changes are needed.
 */
export function normaliseArgumentSpacing(raw: string): string | null {
	if (raw.startsWith('{{') && raw.endsWith('}}')) {
		return normaliseArgsOnly(raw, '{{', '}}');
	}
	if (raw.startsWith('{%') && raw.endsWith('%}')) {
		return normaliseArgsOnly(raw, '{%', '%}');
	}
	return null;
}

// ── internals ─────────────────────────────────────────────────────────────────

/**
 * Decompose a structured tag (expression or block) into its logical parts,
 * apply normalisation to the interior, and reassemble.
 *
 * Layout: `<open><dash?><space?><interior><space?><dash?><close>`
 * where <open> is `{{` or `{%` and <close> is `}}` or `%}`.
 */
function normaliseStructuredTag(raw: string, open: string, close: string): string | null {
	// Multiline tags: preserve the delimiter padding and line breaks, and
	// normalise only the argument spacing. Forcing single-space padding here
	// would collapse a newline right after the opener and destroy the author's
	// multiline structure. Line wrapping is the reflow engine's job, not ours.
	if (raw.includes('\n')) return normaliseArgsOnly(raw, open, close);

	const innerRaw = raw.slice(open.length, raw.length - close.length);

	// Strip optional whitespace-control dash from each end.
	let openDash = '';
	let closeDash = '';
	let interior = innerRaw;

	if (interior.startsWith('-')) {
		openDash = '-';
		interior = interior.slice(1);
	} else if (interior.startsWith('+')) {
		openDash = '+';
		interior = interior.slice(1);
	}

	if (interior.endsWith('-')) {
		closeDash = '-';
		interior = interior.slice(0, -1);
	} else if (interior.endsWith('+')) {
		closeDash = '+';
		interior = interior.slice(0, -1);
	}

	// interior is now the content between the delimiters (and dashes), with
	// any surrounding whitespace still present.
	const trimmed = interior.trim();

	// Normalise the trimmed content (commas, kwargs).
	const normalisedContent = normaliseInnerContent(trimmed);

	// Reassemble with exactly one space on each padding side.
	const normOpen = open + openDash + ' ';
	const normClose = ' ' + closeDash + close;
	const normalised = normOpen + normalisedContent + normClose;

	return normalised === raw ? null : normalised;
}

/**
 * Normalise the argument spacing of a structured tag's interior while leaving
 * the delimiter padding and whitespace-control dashes exactly as-is. The whole
 * interior (including its surrounding whitespace) is copied verbatim except for
 * commas and kwarg `=`, which `normaliseInnerContent` rewrites.
 */
function normaliseArgsOnly(raw: string, open: string, close: string): string | null {
	const inner = raw.slice(open.length, raw.length - close.length);
	const normalised = open + normaliseInnerContent(inner) + close;
	return normalised === raw ? null : normalised;
}

/**
 * Walk the inner content of a jinja tag (everything between the delimiter
 * padding and the closing delimiter), normalising:
 *   - spaces after commas (outside string literals)
 *   - spaces around `=` in kwargs (outside string literals)
 *
 * Does NOT modify content inside single- or double-quoted string literals.
 * Does NOT remove any existing spaces — only adds/removes around comma and `=`.
 */
function normaliseInnerContent(content: string): string {
	// We reconstruct the output character by character, tracking string state.
	let result = '';
	let i = 0;
	const n = content.length;

	while (i < n) {
		const ch = content[i];

		// Inside a string literal — copy verbatim until closing quote.
		if (ch === '\'' || ch === '"') {
			const quote = ch;
			result += ch;
			i++;
			while (i < n) {
				const c = content[i];
				result += c;
				if (c === '\\' && i + 1 < n) {
					// Escaped char — copy both and continue.
					i++;
					result += content[i];
					i++;
					continue;
				}
				i++;
				if (c === quote) break;
			}
			continue;
		}

		// Comma: output comma, consume any trailing spaces, then add exactly one
		// UNLESS the next thing is a line break (a comma at end of line is
		// already separated by the break) or the end of the content.
		if (ch === ',') {
			result += ',';
			i++;
			// Skip existing spaces after the comma.
			while (i < n && content[i] === ' ') i++;
			if (i < n && content[i] !== '\n' && content[i] !== '\r') result += ' ';
			continue;
		}

		// `=` operator: normalise to no-space on either side for kwargs.
		// But `==`, `!=`, `<=`, `>=` must be preserved as-is.
		if (ch === '=') {
			// Check for `==` — skip normalisation for equality operators.
			if (i + 1 < n && content[i + 1] === '=') {
				result += '==';
				i += 2;
				continue;
			}
			// Check for preceding `!`, `<`, `>` — those are `!=`, `<=`, `>=`.
			// We've already emitted those chars, so we just emit `=` here.
			// The spaces around these operator forms aren't our concern (we
			// only target kwarg assignment `=`).  We can identify kwarg `=`
			// by checking what immediately precedes it (an identifier char or `)`)
			// and what follows (not another `=`).
			// Strategy: trim trailing spaces already in `result`, then emit `=`,
			// then skip leading spaces from `content`.
			//
			// Guard: only collapse spaces when the char before the (possibly
			// spaced) `=` in the original looks like an identifier or `)`, and
			// the char after looks like an identifier or `'` or `"`.
			// This avoids mishandling comparison operators that happen to appear
			// after a space.

			const prevChar = result.trimEnd().slice(-1);
			const isAfterIdent = prevChar !== '' && (isIdentOrParen(prevChar));

			// Peek ahead past any spaces to find the next real char.
			let j = i + 1;
			while (j < n && content[j] === ' ') j++;
			const nextChar = j < n ? content[j] : '';
			const isBeforeValue = nextChar !== '' && (isIdentOrQuote(nextChar));

			if (isAfterIdent && isBeforeValue) {
				// Kwarg assignment: strip trailing spaces from result, emit `=`,
				// skip leading spaces, then continue (leading spaces will be
				// handled naturally since we already advanced j).
				result = result.trimEnd() + '=';
				i = j; // skip the `=` and any spaces after it
				continue;
			}

			result += ch;
			i++;
			continue;
		}

		result += ch;
		i++;
	}

	return result;
}

function isIdentOrParen(ch: string): boolean {
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === ')';
}

function isIdentOrQuote(ch: string): boolean {
	// A kwarg value can start with an identifier, number, quote, or an opening
	// bracket: `(` call/tuple, `[` list, `{` dict. All of them mean the `=`
	// before them is a kwarg assignment whose spaces should collapse.
	return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9')
		|| ch === '_' || ch === '\'' || ch === '"' || ch === '(' || ch === '[' || ch === '{';
}
