/**
 * IR-native `AstIndex` for the reflow printer.
 *
 * The legacy index (`src/ninja/reflow/ast-index.ts`) was built over a
 * flat serde dump; this one is built over the sqllens IR (QueryExpr / SelectExpr /
 * SetOpExpr / Expr trees, CteDef, sources, and `SelectExpr.joins`). It answers the
 * exact same byte-range questions the printer asks, using the SAME class-name
 * vocabulary the printer queries — so the printer's AST-driven layout decisions
 * (CTE-separator commas, select-list commas, indented ON, predicate-boolean
 * breaks, CTE/subquery body indentation) fire against real spans instead of
 * degrading to token-stream heuristics.
 *
 * Vocabulary the printer actually queries (grep `enclosing.includes` /
 * `innermost ===` / `findEnclosing` / `containsAny` / `hasInnerEnclosure*` in
 * printer.ts): 'Select', 'With', 'Where', 'Having', 'Group', 'Join', 'Case',
 * 'And', 'Or', 'Func', 'Subquery', 'Paren'. Names the printer never asks for
 * ('CTE', 'Union', 'From', 'Order', 'If', 'Anonymous', column/type nodes) are
 * not produced — the IR maps only onto the queried set:
 *
 *   SelectExpr            -> 'Select'   (spans SELECT … through GROUP BY/HAVING)
 *   QueryExpr.ctes        -> 'With'     (spans the first CTE name … last CTE ')')
 *   CteDef body           -> 'Subquery' (spans the body '(' … ')')
 *   SubquerySource        -> 'Subquery'
 *   Expr subquery/exists  -> 'Subquery'
 *   SelectExpr.where      -> 'Where'
 *   SelectExpr.having     -> 'Having'
 *   SelectExpr.groupBy    -> 'Group'    (spans first … last group key)
 *   Join                  -> 'Join'
 *   Expr case             -> 'Case'
 *   Expr function         -> 'Func'
 *   binary op AND / OR    -> 'And' / 'Or'
 *   a paren-wrapped Expr  -> 'Paren'    (grouping parens, detected by adjacency)
 *
 * Containment ordering matches the legacy index: entries sorted widest-first so
 * a single scan yields outermost→innermost, ties broken by start ascending; the
 * innermost node is the tightest span.
 */
import type { AstIndex } from '../../ninja/reflow/ast-index';
import type { CteDef, Expr, QueryBody, QueryExpr, SelectExpr, Source } from './api';
import { asCst, type SqllensParse } from './extract/spans';

interface Entry {
	c: string;
	/** 0-based inclusive char offset of the first char. */
	start: number;
	/** 0-based inclusive char offset of the last char. */
	end: number;
}

/** A pipe body — not exported from the IR surface, narrowed structurally. */
interface PipeBodyLike {
	kind: 'pipe';
	input: QueryBody;
}

/**
 * Build an {@link AstIndex} from a sqllens parse.
 *
 * `source` is the raw SQL the parse's char offsets are keyed to — used only for
 * the grouping-paren adjacency check (is this Expr directly wrapped in `(` … `)`).
 * On pass1/pass1b the blanking is length-preserving so these offsets line up with
 * the raw source and the printer's token stream; the document parser must NOT
 * attach an index built from a pass2 (nunjucks-rendered) parse, whose offsets are
 * in rendered space.
 */
export function createSqllensAstIndex(parse: SqllensParse, source: string): AstIndex {
	const entries: Entry[] = [];
	/** Char offsets of `(` tokens that open a CTE / subquery body. */
	const bodyOpen = new Set<number>();
	/** All `(` token start offsets, ascending — for finding a body's opening paren. */
	const lparens = parse.tokens
		.filter(t => t.text === '(')
		.map(t => t.start)
		.sort((a, b) => a - b);

	/** The `(` that opens a body: the last `(` in `[outerStart, innerStart)`. */
	function bodyOpenParen(outerStart: number, innerStart: number): number | undefined {
		let found: number | undefined;
		for (const p of lparens) {
			if (p >= innerStart) break;
			if (p >= outerStart) found = p;
		}
		return found;
	}

	function push(c: string, cst: unknown): void {
		const n = asCst(cst);
		if (!n.start || !n.stop) return;
		entries.push({ c, start: n.start.start, end: n.stop.stop });
	}

	/** True when `off` sits over whitespace in the source. */
	const isWs = (off: number): boolean => off >= 0 && off < source.length && /\s/.test(source[off]);

	/**
	 * Emit a 'Paren' entry when an Expr is directly wrapped by grouping parens —
	 * the char before its span (skipping whitespace) is `(` and the char after is
	 * `)`. The printer's inner-exclusion lists use 'Paren' to keep an AND/OR that
	 * sits inside a parenthesized sub-predicate inline (only the top-level operator
	 * between the groups breaks). Function-call parens are never matched here: a
	 * function Expr's span starts at the name, not after a `(`.
	 */
	function maybeParen(cst: unknown): void {
		const n = asCst(cst);
		if (!n.start || !n.stop) return;
		let l = n.start.start - 1;
		while (isWs(l)) l--;
		if (source[l] !== '(') return;
		let r = n.stop.stop + 1;
		while (isWs(r)) r++;
		if (source[r] !== ')') return;
		entries.push({ c: 'Paren', start: l, end: r });
	}

	function walkQuery(q: QueryExpr): void {
		if (q.ctes.length > 0) {
			const first = asCst(q.ctes[0].cst);
			const last = asCst(q.ctes[q.ctes.length - 1].cst);
			if (first.start && last.stop) {
				entries.push({ c: 'With', start: first.start.start, end: last.stop.stop });
			}
			for (const cte of q.ctes) walkCte(cte);
		}
		walkBody(q.body);
		for (const o of q.orderBy ?? []) walkExpr(o);
	}

	function walkCte(cte: CteDef): void {
		const outer = asCst(cte.cst);
		const inner = asCst(cte.body.cst);
		if (outer.start && outer.stop && inner.start) {
			const open = bodyOpenParen(outer.start.start, inner.start.start);
			if (open !== undefined) {
				bodyOpen.add(open);
				// The body paren span acts as the inner 'Subquery' enclosure the
				// printer excludes when deciding CTE-separator commas.
				entries.push({ c: 'Subquery', start: open, end: outer.stop.stop });
			}
		}
		walkQuery(cte.body);
	}

	function walkBody(body: QueryBody): void {
		if (body.kind === 'select') {
			walkSelect(body);
		} else if (body.kind === 'setop') {
			walkBody(body.left);
			walkBody(body.right);
		} else {
			// Pipe body — index the input relation; the per-stage exprs are not
			// queried by the printer's layout decisions (no dbt fixtures use pipes).
			walkBody((body as unknown as PipeBodyLike).input);
		}
	}

	function walkSelect(sel: SelectExpr): void {
		push('Select', sel.cst);
		if (sel.where) {
			push('Where', sel.where.cst);
			walkExpr(sel.where);
		}
		if (sel.having) {
			push('Having', sel.having.cst);
			walkExpr(sel.having);
		}
		if (sel.groupBy && sel.groupBy.length > 0) {
			const gf = asCst(sel.groupBy[0].cst);
			const gl = asCst(sel.groupBy[sel.groupBy.length - 1].cst);
			if (gf.start && gl.stop) {
				entries.push({ c: 'Group', start: gf.start.start, end: gl.stop.stop });
			}
			for (const g of sel.groupBy) walkExpr(g);
		}
		if (sel.qualify) walkExpr(sel.qualify);
		for (const p of sel.projections) walkExpr(p.expr);
		for (const src of sel.from) walkSource(src);
		if (sel.joins && sel.joins.length > 0) {
			for (const j of sel.joins) {
				push('Join', j.cst);
				if (j.on) walkExpr(j.on);
			}
		} else {
			for (const on of sel.joinConditions ?? []) walkExpr(on);
		}
	}

	function walkSource(src: Source): void {
		if (src.kind !== 'subquery') return;
		push('Subquery', src.cst);
		const outer = asCst(src.cst);
		const inner = asCst(src.query.cst);
		if (outer.start && inner.start) {
			const open = bodyOpenParen(outer.start.start, inner.start.start);
			if (open !== undefined) bodyOpen.add(open);
		}
		walkQuery(src.query);
	}

	function walkExpr(ex: Expr): void {
		maybeParen(ex.cst);
		switch (ex.kind) {
			case 'binary': {
				const op = ex.op.toLowerCase();
				if (op === 'and') push('And', ex.cst);
				else if (op === 'or') push('Or', ex.cst);
				walkExpr(ex.left);
				walkExpr(ex.right);
				break;
			}
			case 'unary':
				walkExpr(ex.operand);
				break;
			case 'case':
				push('Case', ex.cst);
				for (const w of ex.whens) {
					walkExpr(w.when);
					walkExpr(w.then);
				}
				if (ex.elseExpr) walkExpr(ex.elseExpr);
				break;
			case 'function':
				push('Func', ex.cst);
				for (const a of ex.args) walkExpr(a);
				break;
			case 'cast':
				walkExpr(ex.expr);
				break;
			case 'subquery':
			case 'exists': {
				push('Subquery', ex.cst);
				const outer = asCst(ex.cst);
				const inner = asCst(ex.query.cst);
				if (outer.start && inner.start) {
					const open = bodyOpenParen(outer.start.start, inner.start.start);
					if (open !== undefined) bodyOpen.add(open);
				}
				walkQuery(ex.query);
				break;
			}
			case 'predicate':
				walkExpr(ex.operand);
				for (const a of ex.args) walkExpr(a);
				break;
			case 'subscript':
				walkExpr(ex.base);
				// Slices (pg family, sqllens 1.6.0) carry any of index/end/step.
				if (ex.index) walkExpr(ex.index);
				if (ex.end) walkExpr(ex.end);
				if (ex.step) walkExpr(ex.step);
				break;
			case 'with':
				for (const b of ex.bindings) walkExpr(b.value);
				walkExpr(ex.result);
				break;
			case 'lambda':
				walkExpr(ex.body);
				break;
			default:
				// column / literal / star / other — no queried enclosure.
				break;
		}
	}

	walkQuery(parse.ast);

	// Widest-first, ties by start ascending — mirrors createAstIndex so a single
	// forward scan yields outermost→innermost for any offset.
	entries.sort((a, b) => {
		const spanA = a.end - a.start;
		const spanB = b.end - b.start;
		if (spanA !== spanB) return spanB - spanA;
		return a.start - b.start;
	});

	return {
		empty: entries.length === 0,

		enclosingClasses(offset) {
			const out: string[] = [];
			for (const e of entries) {
				if (offset >= e.start && offset <= e.end) out.push(e.c);
			}
			return out;
		},

		innermostClass(offset) {
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (offset >= e.start && offset <= e.end) return e.c;
			}
			return undefined;
		},

		findEnclosing(offset, cls) {
			for (let i = entries.length - 1; i >= 0; i--) {
				const e = entries[i];
				if (offset >= e.start && offset <= e.end && e.c === cls) {
					return { start: e.start, end: e.end };
				}
			}
			return undefined;
		},

		containsAny(start, end, classes) {
			const set = new Set(classes);
			for (const e of entries) {
				if (set.has(e.c) && e.start >= start && e.end <= end) return true;
			}
			return false;
		},

		isCteOrSubqueryBodyOpen(offset) {
			return bodyOpen.has(offset);
		},
	};
}

/**
 * Compose per-statement-cell indexes into one document-wide {@link AstIndex}.
 * Each cell is parsed from a masked view of the document (its own text in
 * place, everything else blanked), so cell indexes carry doc-native offsets
 * and their entry sets are DISJOINT — first-hit delegation is exact, and the
 * `containsAny` union can never double-count across cells.
 */
export function compositeAstIndex(indexes: readonly AstIndex[]): AstIndex {
	const live = indexes.filter(i => !i.empty);
	if (live.length === 1) return live[0];
	return {
		empty: live.length === 0,
		enclosingClasses(offset) {
			for (const i of live) {
				const r = i.enclosingClasses(offset);
				if (r.length > 0) return r;
			}
			return [];
		},
		innermostClass(offset) {
			for (const i of live) {
				const r = i.innermostClass(offset);
				if (r !== undefined) return r;
			}
			return undefined;
		},
		findEnclosing(offset, cls) {
			for (const i of live) {
				const r = i.findEnclosing(offset, cls);
				if (r !== undefined) return r;
			}
			return undefined;
		},
		containsAny(start, end, classes) {
			return live.some(i => i.containsAny(start, end, classes));
		},
		isCteOrSubqueryBodyOpen(offset) {
			return live.some(i => i.isCteOrSubqueryBodyOpen(offset));
		},
	};
}
