import type { AstPayload } from '../../ftl/parse-result';

/**
 * Byte-range lookup over a flat AST payload.
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
 * The AST is a flat array with parent-index linkage. We rebuild the tree
 * implicitly by sorting nodes so innermost-first wins on ties, then walk
 * the parent chain via `i` when asked for ancestors.
 */
export interface AstIndex {
	/**
	 * Classes of every node whose byte range wraps `offset`, ordered from
	 * outermost (widest span) to innermost (tightest span). A node that
	 * lacks position metadata is skipped.
	 */
	enclosingClasses(offset: number): string[];

	/**
	 * Class of the smallest node whose byte range wraps `offset`. Returns
	 * undefined when no positioned node contains the offset (e.g. offset
	 * is inside a blanked variant branch or the AST is empty).
	 */
	innermostClass(offset: number): string | undefined;

	/**
	 * True when the AST index has no usable position data. Callers can fall
	 * back to token-stream heuristics instead of querying a dead index.
	 */
	readonly empty: boolean;

	/**
	 * Byte range of the innermost node of `cls` that encloses `offset`.
	 * Returns undefined when no positioned node of that class contains the
	 * offset. Used for "what are the bounds of the Join/Where/Case that I'm
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
	 * an IN list. sqlglot wraps CTE/subquery bodies in `Paren` nodes
	 * whose parents are `Cte` / `Subquery`; we detect by looking at
	 * nodes whose byte range starts here and walking up the parent
	 * chain in the flat AST.
	 */
	isCteOrSubqueryBodyOpen(offset: number): boolean;
}

export function createAstIndex(ast: AstPayload[]): AstIndex {
	const positioned = ast.filter(n => n.m?.start !== undefined && n.m?.end !== undefined);

	// Pre-sort widest-first so a single linear scan produces outer-to-inner
	// ordering for any offset query. Ties broken by start ascending.
	positioned.sort((a, b) => {
		const sa = a.m!.start!, ea = a.m!.end!;
		const sb = b.m!.start!, eb = b.m!.end!;
		const spanA = ea - sa;
		const spanB = eb - sb;
		if (spanA !== spanB) return spanB - spanA;
		return sa - sb;
	});

	return {
		empty: positioned.length === 0,

		enclosingClasses(offset) {
			const out: string[] = [];
			for (const node of positioned) {
				const s = node.m!.start!;
				const e = node.m!.end!;
				if (offset >= s && offset <= e && node.c) {
					out.push(node.c);
				}
			}
			return out;
		},

		innermostClass(offset) {
			// Iterate in reverse of the sorted order so the tightest span is
			// encountered first after any enclosing wider spans.
			for (let i = positioned.length - 1; i >= 0; i--) {
				const node = positioned[i];
				const s = node.m!.start!;
				const e = node.m!.end!;
				if (offset >= s && offset <= e && node.c) {
					return node.c;
				}
			}
			return undefined;
		},

		findEnclosing(offset, cls) {
			// Tightest match wins — iterate reverse of sort order.
			for (let i = positioned.length - 1; i >= 0; i--) {
				const node = positioned[i];
				const s = node.m!.start!;
				const e = node.m!.end!;
				if (offset >= s && offset <= e && node.c === cls) {
					return { start: s, end: e };
				}
			}
			return undefined;
		},

		containsAny(start, end, classes) {
			const set = new Set(classes);
			for (const node of positioned) {
				if (!node.c || !set.has(node.c)) continue;
				const s = node.m!.start!;
				const e = node.m!.end!;
				if (s >= start && e <= end) return true;
			}
			return false;
		},

		isCteOrSubqueryBodyOpen(offset) {
			// Find any node whose byte range STARTS at `offset` (the L_PAREN
			// position) and walk the parent chain in the flat AST via `i`.
			// If any ancestor is a Cte or Subquery, and that ancestor's
			// range also starts reasonably close to this paren, treat it
			// as a body opener.
			//
			// sqlglot typically places the body Paren directly under the
			// Cte/Subquery; we check up to a few parent hops to cover
			// dialect variations (e.g. Postgres wraps CTE bodies in an
			// extra Subquery layer).
			for (const node of ast) {
				if (node.m?.start !== offset) continue;
				let hops = 0;
				let cursor: AstPayload | undefined = node;
				while (cursor && hops < 4) {
					if (cursor.c === 'Cte' || cursor.c === 'Subquery') return true;
					// Stop at major statement boundaries — if we've walked
					// past a Select/From/Where on the way up, we're inside
					// a nested context that isn't a CTE/subquery opener.
					if (cursor !== node && (cursor.c === 'Select' || cursor.c === 'From' || cursor.c === 'Where')) {
						break;
					}
					if (cursor.i === undefined) break;
					cursor = ast[cursor.i];
					hops++;
				}
			}
			return false;
		},
	};
}
