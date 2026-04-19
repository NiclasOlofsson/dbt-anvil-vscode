// --------------------------------------------------------------------------
// Jinja blanker — TypeScript port of bridge.py `_blank_jinja`
//
// Replaces every Jinja tag in a dbt SQL file with a space-padded placeholder
// of identical byte length.  The invariant `result.length === sql.length` means
// every character offset (and therefore every line/column number) produced by
// the downstream sqlglot parse maps directly back to the original source.
// --------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Jinja tag scanner — replaces the old non-greedy regex with a depth-counting
// scanner so that nested {{ }} inside string arguments is handled correctly.
//
// Example: {{ config(post_hook="COPY {{ this }} TO '...'"}) }}
// The non-greedy regex stopped at the inner }}, leaving `) }}` as raw SQL.
// The depth-counter increments on {{ and decrements on }}, yielding the full
// outer tag as one unit.
//
// For {% %} and {# #} tags there is no nesting concern — their respective
// terminators (%} / #}) are unambiguous, so a simple indexOf scan suffices.
// ---------------------------------------------------------------------------
interface JinjaTagMatch {
	index: number;
	0: string; // full tag text — keeps the same shape as a RegExpMatchArray
}

export function* iterJinjaTags(sql: string): Generator<JinjaTagMatch> {
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

// Matches a {{ ref('model') }} or {{ ref("model") }} tag (entire tag, anchored).
// Equivalent to Python: _REF_TAG_RE.fullmatch(tag)
const REF_TAG_RE = /^\{\{[^}]*ref\(\s*['"]([^'"]+)['"]\s*\)[^}]*\}\}$/;

// Matches a {{ source('ns', 'tbl') }} tag (entire tag, anchored).
// Equivalent to Python: _SOURCE_TAG_RE.fullmatch(tag)
const SOURCE_TAG_RE = /^\{\{[^}]*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)[^}]*\}\}$/;

// Matches the opening of any {{ callable(...) }} or {{ ns.callable(...) }} tag.
// Captures the last name component (e.g. 'macro' from 'dbt_utils.macro(').
// Equivalent to Python: _MACRO_TAG_RE.match(tag)
const MACRO_TAG_RE = /^\{\{\s*(?:[a-zA-Z_]\w*\.)*([a-zA-Z_]\w*)\s*\(/;

// dbt macros that produce NO SQL output — their entire tag blanks to spaces.
// A bare identifier replacement (e.g. `_`) before `with` causes parse errors.
const STATEMENT_MACROS = new Set(['config', 'docs', 'print', 'log', 'return', 'exceptions']);

// Base-62 alphabet (digits → lowercase → uppercase), same encoding as URL shorteners.
const B62 = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

function toBase62(n: number): string {
	if (n === 0) return '0';
	let s = '';
	while (n > 0) { s = B62[n % 62] + s; n = Math.floor(n / 62); }
	return s;
}

/** Opaque identifier emitted in the blanked SQL for a single jinja expression. */
export function makeJinjaId(n: number): string {
	return `__j${toBase62(n)}__`;
}

/** Original jinja tag and its position in the raw SQL string. */
export interface JinjaTagInfo {
	/** Full tag text, e.g. `{{ my_macro(arg) }}`. */
	original: string;
	/** 0-based inclusive start offset in the raw SQL string. */
	start: number;
	/** 0-based exclusive end offset in the raw SQL string. */
	end: number;
}

export interface BlankJinjaResult {
	blanked: string;
	/**
	 * Maps each unique ID (e.g. `__j0__`) to the original jinja tag it replaced.
	 * Only populated for tags that received a unique ID — ref/source keep their
	 * real names and are not in this map.
	 */
	idMap: Map<string, JinjaTagInfo>;
}

/**
 * Replace Jinja tags with space-padded SQL-safe placeholders.
 *
 * Preserves `blanked.length === sql.length` and every newline position so that
 * every character offset in the output maps directly back to the original source.
 *
 * Strategy for `{{ }}` expression tags (in priority order):
 * - `{{ ref('model') }}`        → model name, space-padded to tag length
 * - `{{ source('ns', 'tbl') }}` → table name (2nd arg), space-padded
 * - `{{ config(...) }}` etc.    → all spaces (known no-SQL-output macros)
 * - `{{ my_macro(...) }}`       → unique ID `__j0__`, space-padded  (identifier mode)
 *                               → `/* ... *​/` block comment            (comment mode)
 * - `{{ var(...) }}` etc.       → unique ID (name clashes with SQL reserved words)
 * - `{{ arbitrary_expr }}`      → unique ID followed by spaces
 *
 * Block tags `{% %}` and comment tags `{# #}` always blank to spaces.
 * Newlines within tags are always preserved.
 *
 * Unique IDs prevent unknown macros from colliding with real CTE/table names in
 * the blanked SQL, which caused sqlglot to mis-resolve column references.
 * ref/source keep real names because sqlglot needs them for schema-based qualify.
 *
 * `macroMode` controls unknown callable `{{ }}` tags:
 * - `'identifier'` (default): replace with a unique ID.
 *   Works when the macro appears in an expression position; fails when it
 *   appears at statement level (bare identifier after a full SELECT…JOIN).
 * - `'comment'`: replace with a `/* ... *​/` block comment of the same byte
 *   length. Valid in every SQL position — expression or statement level.
 *   Use as pass 1b when identifier mode produces un-parseable SQL.
 */
export function blankJinja(sql: string, macroMode: 'identifier' | 'comment' = 'identifier'): BlankJinjaResult {
	const buf = sql.split('');
	const idMap = new Map<string, JinjaTagInfo>();
	let idCounter = 0;

	const nextId = (tag: string, tagStart: number): string => {
		const id = makeJinjaId(idCounter++);
		idMap.set(id, { original: tag, start: tagStart, end: tagStart + tag.length });
		return id;
	};

	for (const match of iterJinjaTags(sql)) {
		const tag = match[0];
		const start = match.index;
		const end = start + tag.length;

		let identifier: string | undefined;
		let useComment = false;
		// Block tags {% %} and comment tags {# #} always become spaces.
		let blankToSpaces = !tag.startsWith('{{');

		if (tag.startsWith('{{')) {
			const refMatch = REF_TAG_RE.exec(tag);
			if (refMatch) {
				identifier = refMatch[1];
			} else {
				const srcMatch = SOURCE_TAG_RE.exec(tag);
				if (srcMatch) {
					identifier = srcMatch[2];
				} else {
					const macroMatch = MACRO_TAG_RE.exec(tag);
					if (macroMatch) {
						const name = macroMatch[1];
						if (STATEMENT_MACROS.has(name)) {
							// Known no-output macros blank completely to spaces.
							// Do NOT use an ID — a bare identifier before e.g. `with`
							// causes a sqlglot parse error.
							blankToSpaces = true;
						} else if (macroMode === 'comment') {
							useComment = true;
						} else {
							// Unknown callable and VALUE_MACROS both get a unique ID.
							// This prevents collisions with real CTE/table names.
							identifier = nextId(tag, start);
						}
					} else {
						// Non-callable {{ expr }} — assign a unique ID.
						identifier = nextId(tag, start);
					}
				}
			}
		}

		// Collect positions within the tag that are not newlines.
		// Newlines are always preserved so line numbers stay correct.
		const nonNlPositions: number[] = [];
		for (let i = start; i < end; i++) {
			if (sql[i] !== '\n') {
				nonNlPositions.push(i);
			}
		}

		if (useComment) {
			// SQL block comment /* ... */ — valid in any syntactic position.
			if (nonNlPositions.length >= 4) {
				buf[nonNlPositions[0]] = '/';
				buf[nonNlPositions[1]] = '*';
				for (let j = 2; j < nonNlPositions.length - 2; j++) {
					buf[nonNlPositions[j]] = ' ';
				}
				buf[nonNlPositions[nonNlPositions.length - 2]] = '*';
				buf[nonNlPositions[nonNlPositions.length - 1]] = '/';
			} else {
				for (const pos of nonNlPositions) {
					buf[pos] = ' ';
				}
			}
		} else if (identifier !== undefined) {
			// Write identifier chars left-aligned, space-padded.
			// IDs are always single-line so no newline-offset logic is needed.
			for (let j = 0; j < nonNlPositions.length; j++) {
				buf[nonNlPositions[j]] = j < identifier.length ? identifier[j] : ' ';
			}
		} else if (blankToSpaces) {
			for (const pos of nonNlPositions) {
				buf[pos] = ' ';
			}
		}
	}

	return { blanked: buf.join(''), idMap };
}
