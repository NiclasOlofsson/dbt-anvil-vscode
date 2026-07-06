/**
 * Byte-range structural queries over the parsed document.
 *
 * Given a position or a token's byte range, answers "what node classes
 * enclose this location?" — outermost to innermost. The printer uses this
 * to turn token-stream events into clause-aware layout decisions:
 *
 *   - A `COMMA` enclosed by `With` (but not by `Paren` / a function call)
 *     is a CTE separator and deserves a newline.
 *   - An `L_PAREN` whose smallest enclosing node is `Cte` is the opening
 *     paren of a CTE body, not a function call.
 *   - An `ON` whose parent is a `Join` takes `indented_on` treatment.
 *
 * The parser builds the index from its IR/CST spans — see
 * `src/ftl/sqllens/ast-index.ts` for the implementation.
 */
export interface AstIndex {
	/**
	 * Classes of every node whose byte range wraps `offset`, ordered from
	 * outermost (widest span) to innermost (tightest span).
	 */
	enclosingClasses(offset: number): string[];

	/**
	 * Class of the smallest node whose byte range wraps `offset`. Returns
	 * undefined when no node contains the offset (e.g. offset is inside a
	 * blanked variant branch or the index is empty).
	 */
	innermostClass(offset: number): string | undefined;

	/**
	 * True when the index has no usable position data. Callers can fall
	 * back to token-stream heuristics instead of querying a dead index.
	 */
	readonly empty: boolean;

	/**
	 * Byte range of the innermost node of `cls` that encloses `offset`.
	 * Returns undefined when no node of that class contains the offset.
	 * Used for "what are the bounds of the Join/Where/Case that I'm
	 * inside right now?" follow-up queries.
	 */
	findEnclosing(offset: number, cls: string): { start: number; end: number } | undefined;

	/**
	 * True when any node whose class appears in `classes` has a byte range
	 * that falls strictly inside `[start, end]`. Used to answer e.g.
	 * "does this Join's body contain an And/Or chain?" cheaply — a Join
	 * with multi-predicate ON will have an `And`/`Or` node nested inside
	 * its span; a single-comparison ON won't.
	 */
	containsAny(start: number, end: number, classes: string[]): boolean;

	/**
	 * True when an L_PAREN at `offset` opens the body of a CTE or
	 * subquery — as opposed to a function call, a grouping paren, or
	 * an IN list.
	 */
	isCteOrSubqueryBodyOpen(offset: number): boolean;
}

/**
 * Index with no structural data — every query answers "nothing". Used by
 * unit tests that drive the printer with hand-built models; the printer's
 * token-stream fallback heuristics take over.
 */
export const EMPTY_AST_INDEX: AstIndex = {
	empty: true,
	enclosingClasses: () => [],
	innermostClass: () => undefined,
	findEnclosing: () => undefined,
	containsAny: () => false,
	isCteOrSubqueryBodyOpen: () => false,
};
