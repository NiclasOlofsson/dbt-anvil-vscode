/**
 * Layout-semantic classification of token types.
 *
 * Token types are raw strings like 'COMMA', 'AND', 'UNION'.
 * This module groups them into broad layout categories that spacing
 * and line-position rules reason about — one level of indirection so
 * rules don't hard-code raw type strings and dialect variants can add
 * mappings via the `EXTRA_MAPPINGS` export.
 */

export const enum TokenKind {
	Comma = 'comma',
	BooleanOperator = 'boolean_operator', // AND, OR
	ComparisonOperator = 'comparison_operator', // EQ, NEQ, GT, GTE, LT, LTE, IN, LIKE …
	ArithmeticOperator = 'arithmetic_operator', // PLUS, MINUS, STAR, SLASH, MOD …
	BitwiseOperator = 'bitwise_operator', // PIPE, AMPERSAND, CARET, DPIPE …
	CastOperator = 'cast_operator', // DCOLON ( :: )
	SetOperator = 'set_operator', // UNION, INTERSECT, EXCEPT
	ClauseKeyword = 'clause_keyword', // SELECT, FROM, WHERE, GROUP, HAVING, ORDER, LIMIT, QUALIFY
	JoinKeyword = 'join_keyword', // JOIN, INNER, LEFT, RIGHT, FULL, CROSS, OUTER
	OpenParen = 'open_paren', // L_PAREN
	CloseParen = 'close_paren', // R_PAREN
	OpenBracket = 'open_bracket', // L_BRACKET
	CloseBracket = 'close_bracket', // R_BRACKET
	Dot = 'dot', // DOT
	Semicolon = 'semicolon', // SEMICOLON
	Unknown = 'unknown',
}

/** Token type → TokenKind */
const BASE_MAP: Record<string, TokenKind> = {
	// Comma
	'COMMA': TokenKind.Comma,

	// Boolean / logical
	'AND': TokenKind.BooleanOperator,
	'OR': TokenKind.BooleanOperator,
	'NOT': TokenKind.BooleanOperator,

	// Comparison
	'EQ': TokenKind.ComparisonOperator,
	'NEQ': TokenKind.ComparisonOperator,
	'GT': TokenKind.ComparisonOperator,
	'GTE': TokenKind.ComparisonOperator,
	'LT': TokenKind.ComparisonOperator,
	'LTE': TokenKind.ComparisonOperator,
	'IN': TokenKind.ComparisonOperator,
	'NOT_IN': TokenKind.ComparisonOperator,
	'LIKE': TokenKind.ComparisonOperator,
	'ILIKE': TokenKind.ComparisonOperator,
	'GLOB': TokenKind.ComparisonOperator,
	'BETWEEN': TokenKind.ComparisonOperator,
	'IS': TokenKind.ComparisonOperator,

	// Arithmetic
	'PLUS': TokenKind.ArithmeticOperator,
	'MINUS': TokenKind.ArithmeticOperator,
	'STAR': TokenKind.ArithmeticOperator,
	'SLASH': TokenKind.ArithmeticOperator,
	'MOD': TokenKind.ArithmeticOperator,
	'POW': TokenKind.ArithmeticOperator,

	// Bitwise / concat
	'PIPE': TokenKind.BitwiseOperator,
	'DPIPE': TokenKind.BitwiseOperator, // || concat
	'AMPERSAND': TokenKind.BitwiseOperator,
	'CARET': TokenKind.BitwiseOperator,
	'TILDA': TokenKind.BitwiseOperator,
	'LSHIFT': TokenKind.BitwiseOperator,
	'RSHIFT': TokenKind.BitwiseOperator,

	// Cast
	'DCOLON': TokenKind.CastOperator, // PostgreSQL/Databricks :: cast

	// Set operators
	'UNION': TokenKind.SetOperator,
	'INTERSECT': TokenKind.SetOperator,
	'EXCEPT': TokenKind.SetOperator,

	// Clause keywords
	'SELECT': TokenKind.ClauseKeyword,
	'FROM': TokenKind.ClauseKeyword,
	'WHERE': TokenKind.ClauseKeyword,
	'GROUP': TokenKind.ClauseKeyword,
	'HAVING': TokenKind.ClauseKeyword,
	'ORDER': TokenKind.ClauseKeyword,
	'LIMIT': TokenKind.ClauseKeyword,
	'QUALIFY': TokenKind.ClauseKeyword,
	'FETCH': TokenKind.ClauseKeyword,
	'OFFSET': TokenKind.ClauseKeyword,

	// Join keywords (these usually start multi-word phrases: LEFT JOIN, INNER JOIN …)
	'JOIN': TokenKind.JoinKeyword,
	'INNER': TokenKind.JoinKeyword,
	'LEFT': TokenKind.JoinKeyword,
	'RIGHT': TokenKind.JoinKeyword,
	'FULL': TokenKind.JoinKeyword,
	'CROSS': TokenKind.JoinKeyword,
	'OUTER': TokenKind.JoinKeyword,

	// Brackets
	'L_PAREN': TokenKind.OpenParen,
	'R_PAREN': TokenKind.CloseParen,
	'L_BRACKET': TokenKind.OpenBracket,
	'R_BRACKET': TokenKind.CloseBracket,

	// Punctuation
	'DOT': TokenKind.Dot,
	'SEMICOLON': TokenKind.Semicolon,
};

/**
 * Additional mappings registered at runtime (e.g. dialect-specific token types).
 * Callers can push to this before the extension activates. Later entries win.
 */
export const EXTRA_MAPPINGS: Array<[string, TokenKind]> = [];

/** Classify a raw token type string. Unknown types → TokenKind.Unknown. */
export function classify(tokenType: string): TokenKind {
	for (let i = EXTRA_MAPPINGS.length - 1; i >= 0; i--) {
		if (EXTRA_MAPPINGS[i][0] === tokenType) return EXTRA_MAPPINGS[i][1];
	}
	return BASE_MAP[tokenType] ?? TokenKind.Unknown;
}
