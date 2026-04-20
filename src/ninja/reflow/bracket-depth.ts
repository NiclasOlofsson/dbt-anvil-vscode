/**
 * Bracket-depth tracker for the reflow renderer.
 *
 * Tracks the current parenthesis nesting depth and whether we are inside
 * a SQL clause context (SELECT body, FROM, WHERE, etc.). The renderer uses
 * this to compute the indentation level for each token or segment.
 *
 * Depth model:
 *   - Each L_PAREN increments depth; R_PAREN decrements.
 *   - The base indent level is derived from the nesting depth plus whether
 *     we are at the start of a clause body (adds one extra level).
 *   - Jinja block tags (`{% if %}`, `{% for %}`) do NOT affect SQL indent.
 */

import type { SqlToken } from '../../ftl/parse-result';
import type { JinjaToken } from '../../ftl/jinja-tokenizer';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';

export interface DepthState {
	/** Current `(` nesting depth. 0 = top-level statement. */
	parenDepth: number;
	/**
	 * True when the immediately preceding significant token was a clause
	 * keyword (SELECT, FROM, WHERE, …) — signals that the next token starts
	 * an indented body.
	 */
	inClauseBody: boolean;
}

export function initialDepthState(): DepthState {
	return { parenDepth: 0, inClauseBody: false };
}

const CLAUSE_KEYWORDS = new Set([
	'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT',
	'QUALIFY', 'WINDOW', 'UNION', 'INTERSECT', 'EXCEPT',
]);

const JOIN_KEYWORDS = new Set([
	'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
]);

/**
 * Advance the depth state by consuming one token.
 * Returns a NEW state (immutable update pattern).
 */
export function advanceDepth(state: DepthState, tok: SqlToken | JinjaToken): DepthState {
	// JinjaTokens: do not affect SQL depth.
	if ('tagEnd' in tok || !('type' in tok) || typeof (tok as SqlToken).type !== 'string') {
		return state;
	}

	const sqlTok = tok as SqlToken;
	const type = sqlTok.type;

	if (type === 'L_PAREN') {
		return { parenDepth: state.parenDepth + 1, inClauseBody: false };
	}
	if (type === 'R_PAREN') {
		return { parenDepth: Math.max(0, state.parenDepth - 1), inClauseBody: false };
	}

	const isClause = CLAUSE_KEYWORDS.has(type) || JOIN_KEYWORDS.has(type);
	return { parenDepth: state.parenDepth, inClauseBody: isClause };
}

/**
 * Compute the indent column (in spaces) for a token given the current depth.
 *
 * @param state     Current depth state (AFTER consuming the previous token).
 * @param indentSize  Spaces per indent level (from NinjaConfig.indentation.size).
 * @param baseLevel   Additional indentation for this code block (e.g. +1 inside a CTE body).
 */
export function computeIndent(state: DepthState, indentSize: number, baseLevel = 0): number {
	const level = baseLevel + state.parenDepth + (state.inClauseBody ? 1 : 0);
	return level * indentSize;
}

/**
 * Scan a `ninjaSqlTokens` stream and return a map from token `start` offset
 * to its pre-token DepthState. Allows random-access depth lookup for rules
 * that need to know the indent context at any given token position.
 */
export function buildDepthMap(tokens: NinjaSqlToken[]): Map<number, DepthState> {
	const map = new Map<number, DepthState>();
	let state = initialDepthState();
	for (const t of tokens) {
		map.set(t.start, state);
		if (t.category === 'sql') {
			state = advanceDepth(state, t);
		}
	}
	return map;
}
