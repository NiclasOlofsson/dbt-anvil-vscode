/**
 * Byte-level paren / comment scanners over raw SQL.
 *
 * Used to locate CTE boundaries when the AST alone cannot give us the closing
 * `)` position — sqlglot's `_meta` carries only token start positions, so we
 * fall back to scanning the source. These helpers correctly skip strings,
 * SQL line/block comments, and Jinja comments.
 */

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `pos` in `sql` falls inside a SQL line/block comment or a Jinja comment. */
export function isPositionInComment(sql: string, pos: number): boolean {
	const lineStart = sql.lastIndexOf('\n', pos - 1) + 1;
	const lineContent = sql.slice(lineStart, pos);
	if (lineContent.includes('--')) return true;

	let blockDepth = 0;
	let jinjaDepth = 0;
	let i = 0;
	while (i < pos) {
		if (i + 1 < sql.length) {
			const two = sql.slice(i, i + 2);
			if (two === '/*') { blockDepth++; i += 2; continue; }
			if (two === '*/') { blockDepth--; i += 2; continue; }
			if (two === '{#') { jinjaDepth++; i += 2; continue; }
			if (two === '#}') { jinjaDepth--; i += 2; continue; }
		}
		i++;
	}
	return blockDepth > 0 || jinjaDepth > 0;
}

/**
 * Find the opening paren of a CTE definition and return `{ matchStart, parenPos }`.
 * Returns `null` when no non-comment match is found.
 */
export function findCteDef(sql: string, cteName: string): { matchStart: number; parenPos: number } | null {
	// cteName [AS] (  — AS optional (Spark/Databricks); space before '(' optional when AS is present.
	const pattern = new RegExp(`\\b${escapeRegExp(cteName)}(?:\\s+AS\\s*|\\s+)\\(`, 'gi');
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(sql)) !== null) {
		if (!isPositionInComment(sql, match.index)) {
			const parenPos = sql.indexOf('(', match.index);
			return { matchStart: match.index, parenPos };
		}
	}
	return null;
}

/**
 * Given the position of an opening `(`, find the matching `)` while skipping
 * strings and comments. Returns the offset *after* the closing paren, or `-1`
 * when no match is found.
 */
export function findMatchingParen(sql: string, openPos: number): number {
	let depth = 1;
	let i = openPos + 1;
	let inString = false;
	let stringChar = '';
	let inLineComment = false;
	let inBlockComment = false;

	while (i < sql.length && depth > 0) {
		const ch = sql[i];
		const next = i + 1 < sql.length ? sql[i + 1] : '';

		if (!inString && !inBlockComment && ch === '-' && next === '-') {
			inLineComment = true;
			i += 2;
			continue;
		}
		if (inLineComment) {
			if (ch === '\n') inLineComment = false;
			i++;
			continue;
		}

		if (!inString && !inLineComment && ch === '/' && next === '*') {
			inBlockComment = true;
			i += 2;
			continue;
		}
		if (inBlockComment) {
			if (ch === '*' && next === '/') {
				inBlockComment = false;
				i += 2;
			} else {
				i++;
			}
			continue;
		}

		if ((ch === '\'' || ch === '"') && (i === 0 || sql[i - 1] !== '\\')) {
			if (!inString) {
				inString = true;
				stringChar = ch;
			} else if (ch === stringChar) {
				inString = false;
			}
		}

		if (!inString && !inLineComment && !inBlockComment) {
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
		}

		i++;
	}

	return depth === 0 ? i : -1;
}
