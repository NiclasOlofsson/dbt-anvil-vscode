/**
 * Identifier style classification, conversion, and segmentation.
 *
 * Pure functions, no dependencies on the rest of the codebase. Used by the
 * cap-identifiers rule to detect style violations and propose renames, and
 * by the editor to surface a per-project policy.
 *
 * Detection deliberately limits itself to what's recoverable from visible
 * markers (case transitions, separators) plus an optional acronym list
 * (for camelCase/PascalCase runs like `URL`) and an optional word list
 * (for segmenting all-lowercase concatenations like `customerid`). Without
 * those lists we accept `customerid` as conformant snake_case — same as
 * IntelliJ/ReSharper/VS, because heuristic segmentation without a project
 * vocabulary produces more harm than help.
 */

export type IdentifierStyle =
	| 'snake_case'
	| 'camelCase'
	| 'PascalCase'
	| 'lower'
	| 'upper';

export interface StyleOptions {
	/**
	 * Acronyms that may appear as a single run of uppercase letters inside
	 * a camelCase or PascalCase identifier (e.g. `URL`, `ID`). Names are
	 * compared case-insensitively but the stored form is the desired
	 * uppercase rendering for the conversion path.
	 */
	acronyms?: Set<string>;
	/**
	 * Known whole-word tokens used to segment identifiers without visible
	 * markers (e.g. `customerid` → `customer + id` when `id` is in the
	 * list). Segments are matched case-insensitively against this set.
	 */
	words?: Set<string>;
}

// ── matchesStyle ───────────────────────────────────────────────────────

/**
 * Does the given identifier conform to the given style?
 *
 * - `snake_case`: lowercase letters, digits, underscores. Must start with a
 *   letter. `_foo` is rejected (leading underscores are not part of the
 *   policy; they belong to convention rules, not style).
 * - `camelCase`: starts lowercase, contains at least one camel hump or is
 *   a single lowercase word. No underscores/dashes. Acronym runs are
 *   allowed only when the run matches a known acronym.
 * - `PascalCase`: starts uppercase, no underscores/dashes. Acronym runs
 *   allowed when matching a known acronym.
 * - `lower`: all lowercase letters/digits, no separators.
 * - `upper`: all uppercase letters/digits, no separators.
 */
export function matchesStyle(
	name: string,
	style: IdentifierStyle,
	opts: StyleOptions = {},
): boolean {
	if (name.length === 0) return false;

	switch (style) {
		case 'snake_case':
			return /^[a-z][a-z0-9_]*$/.test(name);
		case 'lower':
			return /^[a-z][a-z0-9]*$/.test(name);
		case 'upper':
			return /^[A-Z][A-Z0-9]*$/.test(name);
		case 'camelCase':
			return matchesCamelOrPascal(name, 'camelCase', opts.acronyms ?? new Set());
		case 'PascalCase':
			return matchesCamelOrPascal(name, 'PascalCase', opts.acronyms ?? new Set());
	}
}

function matchesCamelOrPascal(
	name: string,
	style: 'camelCase' | 'PascalCase',
	acronyms: Set<string>,
): boolean {
	if (/[_\-\s]/.test(name)) return false;
	if (!/^[A-Za-z][A-Za-z0-9]*$/.test(name)) return false;

	const startsUpper = name[0] === name[0].toUpperCase() && /[A-Z]/.test(name[0]);
	if (style === 'camelCase' && startsUpper) return false;
	if (style === 'PascalCase' && !startsUpper) return false;

	// Walk and require: any run of 2+ consecutive uppercase letters must
	// match a known acronym exactly (case-insensitive). Single-uppercase
	// transitions are always fine — they delimit segments.
	const acronymsUpper = new Set([...acronyms].map(a => a.toUpperCase()));
	let i = 0;
	while (i < name.length) {
		if (!isUpper(name[i])) { i++; continue; }
		let j = i;
		while (j < name.length && isUpper(name[j])) j++;
		const runLen = j - i;
		if (runLen >= 2) {
			// A run of 2+ uppercase letters. It must be a known acronym.
			// Trim the last char if followed by a lowercase letter — that
			// last upper actually starts the next segment.
			let end = j;
			if (j < name.length && isLower(name[j])) end = j - 1;
			const run = name.slice(i, end);
			if (run.length >= 2 && !acronymsUpper.has(run.toUpperCase())) return false;
		}
		i = j;
	}
	return true;
}

function isUpper(c: string): boolean {
	return c >= 'A' && c <= 'Z';
}

function isLower(c: string): boolean {
	return c >= 'a' && c <= 'z';
}

// ── segmentIdentifier ─────────────────────────────────────────────────

/**
 * Break an identifier into its constituent words.
 *
 * Segmentation uses, in order:
 *   1. Separators (`_`, `-`, whitespace) — always cut.
 *   2. Known acronym runs from `opts.acronyms` — kept as one segment.
 *   3. Case transitions (lower→upper, upper→lower-after-acronym) — cut.
 *   4. Known whole-word matches from `opts.words` against an
 *      all-lowercase identifier with no markers — best-effort cut.
 *
 * Without acronyms/words, `customerid` returns `['customerid']` — we
 * don't invent boundaries.
 */
export function segmentIdentifier(
	name: string,
	opts: StyleOptions = {},
): string[] {
	if (name.length === 0) return [];

	// First, cut on explicit separators.
	const parts: string[] = [];
	for (const piece of name.split(/[_\-\s]+/)) {
		if (piece.length === 0) continue;
		parts.push(...segmentCamelishPiece(piece, opts.acronyms ?? new Set()));
	}

	// If we still have a single all-lowercase piece, try word-list segmentation.
	if (parts.length === 1 && /^[a-z]+$/.test(parts[0]) && opts.words) {
		const segmented = segmentByWordList(parts[0], opts.words);
		if (segmented) return segmented;
	}

	return parts;
}

function segmentCamelishPiece(piece: string, acronyms: Set<string>): string[] {
	const acronymsUpper = new Set([...acronyms].map(a => a.toUpperCase()));
	const out: string[] = [];
	let i = 0;
	while (i < piece.length) {
		// Run of uppercase letters
		if (isUpper(piece[i])) {
			let j = i;
			while (j < piece.length && isUpper(piece[j])) j++;
			const runLen = j - i;
			if (runLen >= 2) {
				// Multi-upper run. If the next char is lowercase, the last upper
				// starts the next segment.
				let end = j;
				if (j < piece.length && isLower(piece[j])) end = j - 1;
				const run = piece.slice(i, end);
				// Check if this is a known acronym.
				if (acronymsUpper.has(run.toUpperCase())) {
					out.push(run);
					i = end;
				} else {
					// Not an acronym — break at the camel transition (first upper).
					// Emit as one segment up to the next lowercase or end.
					out.push(piece.slice(i, end));
					i = end;
				}
			} else {
				// Single upper — start of a camel segment. Walk through lowercase tail.
				let k = j;
				while (k < piece.length && isLower(piece[k])) k++;
				out.push(piece.slice(i, k));
				i = k;
			}
		} else {
			// Lowercase or digit run.
			let j = i;
			while (j < piece.length && !isUpper(piece[j])) j++;
			out.push(piece.slice(i, j));
			i = j;
		}
	}
	return out;
}

function segmentByWordList(name: string, words: Set<string>): string[] | null {
	const wordsLower = new Set([...words].map(w => w.toLowerCase()));
	// Try greedy longest-suffix-first match. Repeat until no more known suffix.
	const segments: string[] = [];
	let remaining = name;
	let progressed = false;
	while (remaining.length > 0) {
		let cut = -1;
		// Try each possible cut from longest known word at suffix end.
		for (let len = remaining.length - 1; len >= 1; len--) {
			const suffix = remaining.slice(len);
			if (wordsLower.has(suffix)) {
				cut = len;
				break;
			}
		}
		if (cut === -1) {
			if (!progressed) return null;          // no known boundary at all
			segments.push(remaining);
			break;
		}
		const head = remaining.slice(0, cut);
		const tail = remaining.slice(cut);
		segments.push(head);
		segments.push(tail);
		progressed = true;
		break;          // single-suffix split is enough for the common case
	}
	return segments.length >= 2 ? segments : null;
}

// ── convertToStyle ────────────────────────────────────────────────────

/**
 * Convert an identifier to the given style — always succeeds for non-empty
 * input by rendering whatever segmentation is available. The returned
 * value may equal the input (when no improvement is possible). Returns
 * `null` only for empty input.
 *
 * The caller decides whether a violation exists by comparing the result
 * against the input: `convertToStyle(name, target, opts) !== name` means
 * a cleaner rendering is available.
 */
export function convertToStyle(
	name: string,
	target: IdentifierStyle,
	opts: StyleOptions = {},
): string | null {
	if (name.length === 0) return null;

	const segments = segmentIdentifier(name, opts);
	if (segments.length === 0) return null;

	const lower = segments.map(s => s.toLowerCase());
	const acronymsUpper = new Set([...(opts.acronyms ?? new Set<string>())].map(a => a.toUpperCase()));

	switch (target) {
		case 'snake_case':
			return lower.join('_');
		case 'lower':
			return lower.join('');
		case 'upper':
			return lower.map(s => s.toUpperCase()).join('');
		case 'camelCase': {
			const head = lower[0];
			const tail = lower.slice(1).map(s =>
				acronymsUpper.has(s.toUpperCase()) ? s.toUpperCase() : capitalizeFirst(s),
			);
			return head + tail.join('');
		}
		case 'PascalCase':
			return lower.map(s =>
				acronymsUpper.has(s.toUpperCase()) ? s.toUpperCase() : capitalizeFirst(s),
			).join('');
	}
}

function capitalizeFirst(s: string): string {
	return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
