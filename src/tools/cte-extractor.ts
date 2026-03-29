/**
 * CTE extractor — TypeScript port of Python cte_generator.extract_cte_sql().
 *
 * Given a model's raw SQL and a CTE name, extracts all SQL from the beginning
 * through the target CTE's closing paren, then appends `SELECT * FROM <cte_name>`.
 */

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Check whether a position in SQL is inside a comment (SQL line/block or Jinja).
 */
export function isPositionInComment(sql: string, pos: number): boolean {
	// Line comment on same line?
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
 * Find the opening paren of a CTE definition and return [matchStart, parenPos].
 * Returns null if no non-comment match found.
 */
export function findCteDef(sql: string, cteName: string): { matchStart: number; parenPos: number } | null {
	// cteName [AS] (  — AS optional (Spark/Databricks); space before '(' optional when AS is present
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
 * Given an opening paren position, find the matching closing paren
 * while skipping strings, line comments, and block comments.
 * Returns the position AFTER the closing paren, or -1 on failure.
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

		// Line comment
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

		// Block comment
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

		// String literals
		if ((ch === '\'' || ch === '"') && (i === 0 || sql[i - 1] !== '\\')) {
			if (!inString) {
				inString = true;
				stringChar = ch;
			} else if (ch === stringChar) {
				inString = false;
			}
		}

		// Parens — only count outside strings & comments
		if (!inString && !inLineComment && !inBlockComment) {
			if (ch === '(') depth++;
			else if (ch === ')') depth--;
		}

		i++;
	}

	return depth === 0 ? i : -1;
}

/**
 * Extract the SQL from the start of a model through a named CTE,
 * appending `SELECT * FROM <cte_name>`.
 *
 * Returns null if the CTE cannot be found.
 */
export function extractCteSql(sql: string, cteName: string): string | null {
	const def = findCteDef(sql, cteName);
	if (!def) return null;

	const closingPos = findMatchingParen(sql, def.parenPos);
	if (closingPos < 0) return null;

	const upstreamSql = sql.slice(0, closingPos).trimEnd();
	return `${upstreamSql}\nSELECT * FROM ${cteName}`;
}
