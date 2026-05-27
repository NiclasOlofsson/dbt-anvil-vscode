/**
 * Cursor-position helpers for live jinja text — used by completion and
 * signature-help, which fire mid-typing on still-incomplete tags that the
 * parsed `DocumentModel.macroCalls` cannot represent (jinja-blanker only
 * tokenizes tags with a matching close).
 *
 * Pure-text walk over the document; no Pyodide, no AST.
 */

/**
 * True when the cursor offset sits inside an unclosed `{{` or `{%` tag,
 * looking only at text *before* the cursor. `{# #}` comments are also
 * detected (rare, but worth skipping in completion logic).
 *
 * Does not require the tag to be closed — that's the whole point of using
 * this over `DocumentModel.macroCalls` mid-typing.
 */
export function isCursorInsideOpenJinjaTag(text: string, offset: number): boolean {
	let i = 0;
	let openKind: '{{' | '{%' | '{#' | null = null;
	while (i < offset) {
		if (openKind === null) {
			if (text[i] === '{' && i + 1 < offset) {
				const next = text[i + 1];
				if (next === '{') { openKind = '{{'; i += 2; continue; }
				if (next === '%') { openKind = '{%'; i += 2; continue; }
				if (next === '#') { openKind = '{#'; i += 2; continue; }
			}
			i++;
		} else {
			// Look for the matching close. For {{ we depth-count nested braces
			// (mirroring iterJinjaTags); for {% and {# the terminator is unambiguous.
			if (openKind === '{{') {
				if (text[i] === '}' && i + 1 < offset && text[i + 1] === '}') {
					openKind = null; i += 2; continue;
				}
				if (text[i] === '{' && i + 1 < offset && text[i + 1] === '{') {
					// Nested {{ — skip the open; the depth scanner in jinja-blanker
					// handles full depth tracking but a single-step skip suffices here
					// since we only care whether *some* tag is open at `offset`.
					i += 2; continue;
				}
				i++;
			} else if (openKind === '{%') {
				if (text[i] === '%' && i + 1 < offset && text[i + 1] === '}') {
					openKind = null; i += 2; continue;
				}
				i++;
			} else {
				if (text[i] === '#' && i + 1 < offset && text[i + 1] === '}') {
					openKind = null; i += 2; continue;
				}
				i++;
			}
		}
	}
	return openKind !== null;
}

export interface InProgressMacroCall {
	/** Bare macro identifier */
	name: string;
	/** Package qualifier when called as `package.name(...)` */
	packageName?: string;
	/** 0-based index of the argument the cursor is currently in (commas at depth 0) */
	activeArg: number;
}

const IDENT = /[A-Za-z_]\w*/;

/**
 * Walk backwards from the cursor through the text to find the innermost
 * unmatched `(` that lies inside an open jinja tag, then identify the macro
 * identifier (and optional `package.` qualifier) immediately before it.
 *
 * Returns undefined when the cursor is not inside an in-progress macro call.
 *
 * String literals (single or double-quoted) are respected so that parens or
 * commas inside `'foo (bar)'` don't confuse the scanner.
 */
export function findEnclosingMacroCall(text: string, offset: number): InProgressMacroCall | undefined {
	if (!isCursorInsideOpenJinjaTag(text, offset)) return undefined;

	// Walk forward from the start of the document to the cursor, tracking
	// paren depth and string state. Record where each unmatched `(` opens
	// (relative to depth at that time) so we can find the innermost one.
	let i = 0;
	let inString: '\'' | '"' | null = null;
	const parenStack: { openIdx: number; commaCount: number }[] = [];

	while (i < offset) {
		const ch = text[i];
		if (inString) {
			if (ch === '\\') { i += 2; continue; }
			if (ch === inString) inString = null;
			i++;
			continue;
		}
		if (ch === '\'' || ch === '"') { inString = ch; i++; continue; }
		if (ch === '(') {
			parenStack.push({ openIdx: i, commaCount: 0 });
			i++;
			continue;
		}
		if (ch === ')') {
			parenStack.pop();
			i++;
			continue;
		}
		if (ch === ',' && parenStack.length > 0) {
			parenStack[parenStack.length - 1].commaCount++;
			i++;
			continue;
		}
		i++;
	}

	const innermost = parenStack[parenStack.length - 1];
	if (!innermost) return undefined;

	// Walk backwards from the open paren over whitespace and identify the
	// macro identifier (possibly `pkg.name`).
	let p = innermost.openIdx - 1;
	while (p >= 0 && /\s/.test(text[p])) p--;
	// Read identifier
	let nameEnd = p + 1;
	while (p >= 0 && /\w/.test(text[p])) p--;
	const nameStart = p + 1;
	const name = text.slice(nameStart, nameEnd);
	if (!name || !IDENT.test(name)) return undefined;

	let packageName: string | undefined;
	if (p >= 0 && text[p] === '.') {
		let q = p - 1;
		const pkgEnd = q + 1;
		while (q >= 0 && /\w/.test(text[q])) q--;
		const pkgStart = q + 1;
		const pkg = text.slice(pkgStart, pkgEnd);
		if (pkg && IDENT.test(pkg)) packageName = pkg;
	}

	return {
		name,
		...(packageName ? { packageName } : {}),
		activeArg: innermost.commaCount,
	};
}
