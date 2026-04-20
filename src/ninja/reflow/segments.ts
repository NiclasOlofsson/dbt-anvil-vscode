/**
 * Segment types for the Ninja reflow engine.
 *
 * The segmenter produces a tree of these; the renderer walks it top-down.
 * The model is deliberately shallow — we don't try to parse full SQL
 * grammar, just enough to handle the clause/list/paren structure that
 * appears in dbt models.
 */

import type { SqlToken } from '../../ftl/parse-result';
import type { JinjaToken } from '../../ftl/jinja-tokenizer';

/** A single SQL token (keyword, identifier, literal, operator, punctuation). */
export interface AtomSegment {
	type: 'atom';
	token: SqlToken;
	/** Verbatim text of this token from the original source. */
	text: string;
}

/** A jinja tag treated as an opaque atom — never split or modified internally. */
export interface JinjaSegment {
	type: 'jinja';
	token: JinjaToken;
	/** Verbatim text of this tag from the original source. */
	text: string;
}

/** A comma-separated list of items. The commas themselves are not stored here. */
export interface ListSegment {
	type: 'list';
	items: Segment[][];
	/**
	 * True when a trailing comma follows the last item in the original source.
	 * Preserved to avoid semantic change on round-trip.
	 */
	trailingComma: boolean;
}

/** A parenthesised group: `( ... )`. The parens are implicit. */
export interface ParenSegment {
	type: 'paren';
	body: Segment[];
	/** True when the body contains a `ListSegment` (affects inline vs expanded decision). */
	hasList: boolean;
}

/**
 * A SQL clause: a keyword (e.g. SELECT, FROM, WHERE) followed by its body.
 * The body may contain lists, parens, other keywords (for subqueries), etc.
 */
export interface ClauseSegment {
	type: 'clause';
	/** The opening keyword token(s). Multi-word clauses (GROUP BY, ORDER BY) have >1. */
	keywords: SqlToken[];
	/** Verbatim text of the clause keyword(s) as written. */
	keywordText: string;
	/** Content following the keyword. */
	body: Segment[];
}

/**
 * A CTE definition: `<name> as ( <body> )`.
 * The `as` and parens are implicit; body is recursively segmented.
 */
export interface CteSegment {
	type: 'cte';
	/** CTE name token. */
	nameToken: SqlToken;
	name: string;
	/** Segments inside the CTE body (already recursively parsed). */
	body: Segment[];
}

/** A WITH block: `with <ctes> <final-select>`. */
export interface WithSegment {
	type: 'with';
	ctes: CteSegment[];
	/** The final SELECT after all CTEs. */
	finalSelect: Segment[];
}

/** A set operator (UNION ALL, UNION DISTINCT, INTERSECT, EXCEPT). */
export interface SetOpSegment {
	type: 'setop';
	/** Tokens that make up the operator: [UNION, ALL], [INTERSECT], etc. */
	tokens: SqlToken[];
	text: string;
}

/** A plain statement (SELECT without WITH). */
export interface StatementSegment {
	type: 'statement';
	clauses: ClauseSegment[];
}

/** A literal blank-line separator preserved from the source. */
export interface BlankLineSegment {
	type: 'blank-line';
}

/** A comment line preserved verbatim. */
export interface CommentSegment {
	type: 'comment';
	text: string;
}

export type Segment =
	| AtomSegment
	| JinjaSegment
	| ListSegment
	| ParenSegment
	| ClauseSegment
	| CteSegment
	| WithSegment
	| StatementSegment
	| SetOpSegment
	| BlankLineSegment
	| CommentSegment;

export type TopLevelSegment = WithSegment | StatementSegment | SetOpSegment | CommentSegment | BlankLineSegment;
