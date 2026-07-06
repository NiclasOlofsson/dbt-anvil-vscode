/**
 * Default spacing/line-position specs for the Ninja layout rules.
 *
 * Each spec maps one or more token types to:
 *   - the diagnostic tag (rule id) it belongs to
 *   - the expected line position (or runtime config path)
 *   - optional space requirements
 *
 * Rules import the spec(s) they care about and pass them to runSpacingEngine.
 * Using named exports keeps tree-shaking intact and makes the mapping readable.
 */

import type { TokenSpec } from './spacing-engine';
import type { NinjaConfig } from '../config';

/** ninja.convention.comma-position — trailing vs leading commas. */
export const COMMA_SPEC: TokenSpec = {
	tokenTypes: 'COMMA',
	diagnostic: 'ninja.convention.comma-position',
	configLinePosition: (c: NinjaConfig) => c.layout.commaPosition,
};

/**
 * ninja.layout.comma-spacing — no space before a comma, exactly one space
 * after. Only fires within the same line; cross-line commas (leading-comma
 * style) skip the same-line check in the engine.
 */
export const COMMA_SPACING_SPEC: TokenSpec = {
	tokenTypes: 'COMMA',
	diagnostic: 'ninja.layout.comma-spacing',
	spaceBefore: 'no-space',
	spaceAfter: 'space',
};

/** ninja.convention.operator-position — trailing vs leading boolean operators. */
export const OPERATOR_SPEC: TokenSpec = {
	tokenTypes: ['AND', 'OR'],
	diagnostic: 'ninja.convention.operator-position',
	configLinePosition: (c: NinjaConfig) => c.layout.operatorPosition,
};

/**
 * ninja.layout.set-operator — UNION/INTERSECT/EXCEPT must each appear alone on
 * their own line (blank-line-before and blank-line-after is handled by the
 * max-blank-lines rule; here we just enforce the "alone" line-position policy).
 */
export const SET_OPERATOR_SPEC: TokenSpec = {
	// The lexer collapses `UNION ALL` into a single `UNION_ALL` token type and
	// `UNION DISTINCT` into `UNION_DISTINCT`. Both must be covered here —
	// leaving them out is a source of false-negatives on chained queries.
	tokenTypes: ['UNION', 'UNION_ALL', 'UNION_DISTINCT', 'INTERSECT', 'EXCEPT'],
	diagnostic: 'ninja.layout.set-operator',
	linePosition: 'alone',
};

/**
 * ninja.layout.clause-keyword — SQL clause openers (WHERE, GROUP BY, ORDER BY,
 * HAVING, LIMIT, QUALIFY) must be leading (first non-space content on their line).
 *
 * SELECT and FROM are intentionally excluded: SELECT almost always opens a
 * new statement/CTE and FROM is also usually leading in dbt style, but both
 * have frequent legitimate trailing positions (e.g. `select foo from t`
 * on one line). The reflow engine (Layer 3) handles the full SELECT layout.
 *
 * Note: GROUP, ORDER, HAVING, LIMIT are individual keywords.
 * "GROUP BY" is two tokens; we flag GROUP and let the next token (BY) follow.
 */
export const CLAUSE_KEYWORD_SPEC: TokenSpec = {
	tokenTypes: ['WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'QUALIFY'],
	diagnostic: 'ninja.layout.clause-keyword',
	linePosition: 'leading',
};

/**
 * ninja.layout.spacing — No space after `(` / before `)`.
 * Two separate specs keyed by bracket type.
 */
export const OPEN_PAREN_SPEC: TokenSpec = {
	tokenTypes: 'L_PAREN',
	diagnostic: 'ninja.layout.spacing',
	spaceAfter: 'no-space',
};

export const CLOSE_PAREN_SPEC: TokenSpec = {
	tokenTypes: 'R_PAREN',
	diagnostic: 'ninja.layout.spacing',
	spaceBefore: 'no-space',
};

/**
 * ninja.layout.binary-operator-spacing — require a space on both sides of
 * comparison/equality operators. Arithmetic ops (`+`, `-`, `*`, `/`) are
 * intentionally excluded: `*` is also SELECT-star, `-` is also unary
 * negation, and inline arithmetic (e.g. `col1+col2`) is common enough that
 * flagging it would create noise.
 */
export const BINARY_OPERATOR_SPEC: TokenSpec = {
	tokenTypes: ['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE'],
	diagnostic: 'ninja.layout.binary-operator-spacing',
	spaceBefore: 'space',
	spaceAfter: 'space',
};

/** All built-in spacing specs in one array, in priority order (first match wins). */
export const ALL_SPECS: TokenSpec[] = [
	COMMA_SPEC,
	OPERATOR_SPEC,
	SET_OPERATOR_SPEC,
	CLAUSE_KEYWORD_SPEC,
	OPEN_PAREN_SPEC,
	CLOSE_PAREN_SPEC,
];
