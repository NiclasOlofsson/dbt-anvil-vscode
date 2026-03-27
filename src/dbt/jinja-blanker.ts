// --------------------------------------------------------------------------
// Jinja blanker — TypeScript port of bridge.py `_blank_jinja`
//
// Replaces every Jinja tag in a dbt SQL file with a space-padded placeholder
// of identical byte length.  The invariant `result.length === sql.length` means
// every character offset (and therefore every line/column number) produced by
// the downstream sqlglot parse maps directly back to the original source.
// --------------------------------------------------------------------------

// Matches all Jinja tag types: block {% %}, expression {{ }}, comment {# #}
// Using the 'g' flag so the regex works with matchAll.
const JINJA_TAG_RE = /\{%-?[\s\S]*?-?%\}|\{\{[\s\S]*?\}\}|\{#-?[\s\S]*?-?#\}/g;

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

/**
 * Replace Jinja tags with space-padded SQL-safe placeholders.
 *
 * Preserves `result.length === sql.length` and every newline position so that
 * every character offset in the output maps directly back to the original source.
 *
 * Strategy for `{{ }}` expression tags (in priority order):
 * - `{{ ref('model') }}`        → model name, space-padded to tag length
 * - `{{ source('ns', 'tbl') }}` → table name (2nd arg), space-padded
 * - `{{ config(...) }}` etc.    → all spaces (known no-SQL-output macros)
 * - `{{ my_macro(...) }}`       → macro name, space-padded
 * - `{{ ns.macro(...) }}`       → last name component, space-padded
 * - `{{ arbitrary_expr }}`      → `_` followed by spaces
 *
 * Block tags `{% %}` and comment tags `{# #}` always blank to spaces.
 * Newlines within tags are always preserved.
 */
export function blankJinja(sql: string): string {
	const buf = sql.split('');

	for (const match of sql.matchAll(JINJA_TAG_RE)) {
		const tag = match[0];
		const start = match.index!;
		const end = start + tag.length;

		let identifier: string | undefined;
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
							// Do NOT fall through to the `_` fallback — a bare `_`
							// before e.g. `with` causes a sqlglot parse error.
							blankToSpaces = true;
						} else {
							identifier = name;
						}
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

		if (identifier !== undefined) {
			// Write identifier chars left-aligned, space-pad the remainder.
			for (let j = 0; j < nonNlPositions.length; j++) {
				buf[nonNlPositions[j]] = j < identifier.length ? identifier[j] : ' ';
			}
		} else if (blankToSpaces) {
			for (const pos of nonNlPositions) {
				buf[pos] = ' ';
			}
		} else {
			// Unknown {{ expr }} with no callable name.
			// Use `_` as the first non-newline char so the tag produces a valid
			// SQL identifier when it lands in an expression position.
			for (let j = 0; j < nonNlPositions.length; j++) {
				buf[nonNlPositions[j]] = j === 0 ? '_' : ' ';
			}
		}
	}

	return buf.join('');
}
