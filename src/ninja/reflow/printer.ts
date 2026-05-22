import type { NinjaConfig } from '../config';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import type { AstPayload, SqlToken } from '../../ftl/parse-result';
import type { DialectSymbols } from '../../ftl/sql-parser';
import type { IndentPolicy } from './indent-policy';
import { createCapitalisationState, recaseToken } from './capitalisation';
import { createAstIndex } from './ast-index';
import { normaliseTagSpacing } from '../jinja/tag-formatter';

export interface PrinterInput {
	stream: NinjaSqlToken[];
	ast: AstPayload[];
	source: string;
	config: NinjaConfig;
	policy: IndentPolicy;
	/**
	 * Optional dialect-aware symbol sets. When supplied the printer uses
	 * them for function and type capitalisation; otherwise falls back to
	 * hardcoded sets in `capitalisation.ts` (sufficient for unit tests).
	 */
	symbols?: DialectSymbols;
}

/**
 * Token types (uppercased) that start a major SQL clause and deserve a line
 * break at paren depth 0. The printer emits a newline before each of these
 * and resets the indent to `baseIndent` (root-level clauses).
 *
 * Multi-word compounds like `GROUP_BY` / `ORDER_BY` are emitted by sqlglot
 * as single tokens, which is why they appear here as single strings.
 */
const MAJOR_CLAUSES = new Set([
	'SELECT', 'FROM', 'WHERE',
	'GROUP_BY', 'GROUP', // sqlglot sometimes emits bare GROUP + BY
	'HAVING',
	'ORDER_BY', 'ORDER',
	'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW', 'FETCH',
]);

/**
 * Keywords that begin a JOIN phrase. A newline fires before the first of
 * these in a JOIN cluster; subsequent modifier tokens (INNER, OUTER, LEFT,
 * etc.) are emitted on the same line.
 */
const JOIN_START = new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS']);
/**
 * When the previous token is itself a JOIN modifier, the current JOIN-start
 * token is a continuation of the same JOIN cluster (e.g. `LEFT JOIN`,
 * `FULL OUTER JOIN`) and must not trigger a second newline.
 */
const JOIN_CONTINUATION_PREV = new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS']);

const SET_OPERATOR = new Set(['UNION', 'INTERSECT', 'EXCEPT']);

/**
 * Token types whose text must not take a space on its left. These sit
 * flush against the preceding token — e.g. the `(` in a function call, the
 * `.` in `schema.table`, the comma (space handling is policy-driven).
 */
const NO_SPACE_BEFORE = new Set(['COMMA', 'R_PAREN', 'R_BRACKET', 'DOT', 'SEMICOLON', 'DCOLON']);

/**
 * Token types whose text must not take a space on its right. The open
 * paren hugs the identifier before it for function calls and hugs the
 * next token for grouping. `.` in qualified names works the same way.
 */
const NO_SPACE_AFTER = new Set(['L_PAREN', 'L_BRACKET', 'DOT', 'DCOLON']);

/**
 * Render a formatted SQL document from a parsed token stream.
 *
 * The printer is a two-track walker:
 *   - **Structure track** — injects newlines before major clauses and JOINs,
 *     maintains indent depth based on paren nesting, and emits fresh
 *     whitespace between tokens according to spacing policy.
 *   - **Preservation track** — copies token text verbatim (after
 *     capitalisation), copies Jinja regions byte-identically, and keeps
 *     original-source slices for any range the structural walker does not
 *     touch.
 *
 * Comments and Jinja are surfaced through the token stream (comments ride
 * on `SqlToken.comments[]`; Jinja tokens carry `tagEnd` markers). Any
 * whitespace BETWEEN tokens in the original source is discarded and
 * regenerated — that is what makes this a reflow rather than a passthrough.
 */
export function printDocument(input: PrinterInput): string {
	const { stream, ast, source, config, policy, symbols } = input;
	if (stream.length === 0) return source;

	const astIndex = createAstIndex(ast);

	// Pre-pass: collect byte ranges of every SQL comment. Jinja tokens that
	// sit inside a comment range are false positives from the independent
	// Jinja tokenizer — e.g. `-- note about {{ ref('x') }}` will look like
	// Jinja to the tokenizer even though it's part of a SQL comment. We
	// drop those jinja tokens during the walk to keep formatting
	// idempotent.
	const commentRanges: Array<{ start: number; end: number }> = [];
	for (const tok of stream) {
		if (tok.category !== 'sql' || !tok.comments?.length) continue;
		for (const c of tok.comments) commentRanges.push({ start: c.start, end: c.end });
	}

	// Pre-pass: figure out which Select nodes will overflow maxLineLength
	// if rendered on a single line. A single-line SELECT is roughly
	// `select` + sum(token-widths) + (#tokens - 1) for inter-token spaces.
	// When that exceeds the limit we force per-comma wrapping for that
	// Select's targets. Computing this upfront keeps the main walk
	// deterministic: the same comma either always breaks or never does.
	const mustWrapSelectRanges = computeMustWrapSelects(stream, config.maxLineLength, policy);
	// Pre-pass token-stream fallback for SELECT-list comma detection. The AST
	// path (`enclosing.includes('Select')`) misses commas when the Select node
	// has no position metadata in sqlglot's serde dump — common for nested
	// CTE-body selects. This set records the start offset of every comma that
	// separates SELECT targets at depth 0 inside a SELECT...FROM/WHERE/etc.
	// range.
	const selectListCommaOffsets = computeSelectListCommas(stream);
	// Pre-pass token-stream fallback for predicate AND/OR detection. The AST
	// path (`enclosing.includes('Where' | 'Having' | 'Join')`) misses ANDs/ORs
	// when sqlglot's serde drops position metadata on the Where/Having/Join
	// node — without this fallback the predicate-boolean break never fires,
	// leaving `where a = 1 and b = 2` un-wrapped.
	const predicateBooleanOffsets = computePredicateBooleans(stream);
	// Pre-pass token-stream fallback for multi-predicate JOIN-ON detection.
	// sqlglot's serde leaves `Join.m` empty, so `findEnclosing(... 'Join')`
	// returns a node with no byte range and `containsAny(... 'And'|'Or')`
	// can't walk children that also lack ranges. Without this fallback the
	// `indented_on` multi-predicate split never fires on real parser output,
	// collapsing `... on a.x = b.x and a.y = b.y and ...` to a single
	// mega-line.
	const multiPredicateJoinOnRanges = computeMultiPredicateJoinOnRanges(stream);
	// Pre-pass: locate CASE...END spans whose single-line projected width would
	// exceed `maxLineLength`. The set of CASE token start offsets identifies
	// the entries — during the walk we push CASE state on a stack at each
	// matching CASE and emit per-WHEN / per-ELSE / per-END breaks, restoring
	// indent at END.
	const mustWrapCaseStarts = computeMustWrapCases(stream, config.maxLineLength, policy);
	// Pre-pass: inside an already-wide CASE, locate THEN tokens whose result
	// expression keeps the `when COND then RESULT` line over `maxLineLength`.
	// Returns a set of THEN-token start offsets. When the walker emits the
	// token that follows such a THEN, it forces a newline and bumps indent
	// one level so the RESULT lands on its own indented line.
	const mustBreakAfterThenOffsets = computeMustBreakAfterThens(
		stream, mustWrapCaseStarts, config.maxLineLength, policy);
	// Pre-pass: locate `over (...)` window-function parens whose contained
	// SELECT target would overflow `maxLineLength` on a single line. Set of
	// L_PAREN start offsets for the offending `(`s. When the walker hits
	// one, the paren becomes "indenting" and PARTITION_BY / ORDER_BY inside
	// break onto their own indented lines.
	const mustWrapWindowParenStarts = computeMustWrapWindows(stream, config.maxLineLength, policy);
	// Pre-pass: locate top-level arithmetic operators inside SELECT targets
	// whose single-line projection would exceed `maxLineLength` and that
	// have no CASE/window/scalar-subquery (those have their own dedicated
	// wraps). Set of operator-token start offsets. When the walker emits
	// the operator, it breaks before (leading) or after (trailing) it.
	const mustWrapWideExprOps = computeMustWrapWideExpressions(stream, config.maxLineLength, policy);

	const parts: string[] = [];
	const cap = createCapitalisationState(symbols);

	let parenDepth = 0;
	let indentLevel = 0;
	// Stack of paren-depth markers for parens that opened a CTE body or
	// subquery and therefore increased `indentLevel`. On the matching
	// close paren we pop and decrement, so nested function calls inside a
	// CTE body don't touch indent.
	const indentingParens: number[] = [];
	// Parallel stack of "extra base indent" deltas for each indenting paren.
	// When an indenting paren opens on a continuation line (the line consumed
	// `oneShotExtraIndent > 0` at its newline — e.g. an `in (` at the tail of
	// an AND-chain inside a JOIN ON), the body inside that paren needs to land
	// deeper than `indentLevel + 1` to clear the continuation column. We push
	// the consumed extra-indent of the opener's line here and add it to
	// `indentLevel` on open; the matching close subtracts the same delta.
	const indentingParenExtras: number[] = [];
	// Parallel stack: true when the indenting paren is a wide `over (...)`
	// window. Drives the R_PAREN-emit indent restore — only wide windows
	// close at the opener's continuation column; CTE bodies / subqueries /
	// IN-subqueries close at the outer base.
	const indentingParenIsWindow: boolean[] = [];
	// Extra-indent currently in effect on the line being built. Set by
	// `emitNewline()` from whatever `oneShotExtraIndent` it just consumed,
	// then read by the L_PAREN path to decide whether the next indenting
	// paren needs an extended base inside.
	let currentLineExtraIndent = 0;
	// True between a top-level `WITH` token and the trailing top-level
	// `SELECT` that consumes the WITH clause. Used as a token-stream
	// fallback for CTE-separator-comma detection when the AST doesn't
	// propagate positions to the `With` node — sqlglot's serde leaves
	// `With.m` empty in current dumps, so byte-range queries can't see
	// it. The flag flips off the first SELECT we see at parenDepth==0
	// after opening the WITH (the final SELECT after all CTEs).
	let inWithClause = false;
	// Function-call / non-indenting paren depth. Major clauses break on
	// newlines only when this is zero — inside a function call we keep
	// everything on one line, but inside a CTE body (indenting paren)
	// we still want SELECT/FROM/WHERE/etc on their own lines.
	let nonIndentingParenDepth = 0;
	let atLineStart = true;
	let prev: NinjaSqlToken | undefined;
	let prevTypeUpper = '';
	let pendingNewline = false;
	// One-shot flag: insert a BLANK line at the next emitNewline. The blank
	// line "rides" through any intervening Jinja tags so a Jinja `{% if %}`
	// between CTE definitions doesn't swallow the blank — the blank lands
	// before the NEXT CTE name regardless of the Jinja in between.
	let pendingBlankLine = false;
	// Index in `parts` where the most recent SQL token's literal was pushed.
	// Used by the end-of-stream trailing-comma injection to insert the comma
	// between the last SQL token and any trailing comments attached to it.
	let lastSqlPartsIdx = -1;

	// One-shot extra indent used for `indented_on` / `indented_then` /
	// `indented_joins`: consumed by the next `emitNewline()` and then
	// reset to 0, so only the single line introduced by the trigger
	// token receives the deeper indent.
	let oneShotExtraIndent = 0;

	// Stack of active wide-CASE wraps. Each entry records the state to
	// restore at the matching END: the `indentLevel` BEFORE the CASE bumped
	// it, and the line-extra-indent that the CASE-bearing line carried (so
	// END lands at exactly CASE's column, not the base indent).
	// `paren` is the paren depth at which CASE opened — used so nested
	// non-wide CASEs inside a wide CASE don't accidentally consume the
	// outer's END.
	const caseStack: Array<{ savedIndent: number; savedExtra: number }> = [];
	// Parallel depth tracker: every CASE token (wide or not) pushes onto
	// this counter; every END pops. Lets us identify which END matches a
	// wide CASE: a wide CASE pushes `caseStack` AND `nestedCaseDepth`, while
	// a non-wide CASE only pushes `nestedCaseDepth`. The matching END pops
	// `caseStack` only when `caseStack.length === nestedCaseDepth` (i.e. the
	// current CASE level corresponds to the top wide-CASE entry).
	let nestedCaseDepth = 0;
	// Mirror stack of "is this CASE level wide". Tracks whether each open
	// CASE was registered as wide, so the matching END knows whether to
	// pop `caseStack`. Indexed by CASE nesting depth.
	const caseIsWide: boolean[] = [];

	// One-shot flag: under `commaPosition: 'leading'`, the CTE-separator
	// comma's iteration peeks forward to drain the leading comments of the
	// next SQL token (so the comment block sits BETWEEN the CTEs and the
	// comma leads the identifier on the same line). The next token must
	// then SKIP its own leading-comment drain to avoid double-emission.
	let skipNextTokenLeadingComments = false;

	const emitNewline = (): void => {
		if (atLineStart && parts.length === 0) return;
		if (pendingBlankLine) {
			// Don't double-blank when the last emission was already a blank-
			// terminated line (consecutive emitNewlines without intervening
			// content would otherwise stack two extra newlines).
			if (!atLineStart) parts.push('\n');
			parts.push('\n');
			pendingBlankLine = false;
		} else {
			parts.push('\n');
		}
		parts.push(policy.at(indentLevel + oneShotExtraIndent));
		currentLineExtraIndent = oneShotExtraIndent;
		oneShotExtraIndent = 0;
		atLineStart = true;
	};

	const emitSpace = (): void => {
		if (atLineStart) return;
		const last = parts[parts.length - 1];
		if (last && last.endsWith(' ')) return;
		parts.push(' ');
	};

	/**
	 * Emit a single comment at the current cursor position. `position` tells
	 * us whether the comment was attached BEFORE or AFTER its owning token
	 * in the source:
	 *   - `before` → emit on its own line, matching the current indent.
	 *     Line comments (`--`) force a line break after; block comments
	 *     (`/*`) don't.
	 *   - `after`  → emit inline on the same line as the just-emitted token.
	 *     Line comments force a newline after so subsequent tokens don't
	 *     end up commented out.
	 *
	 * This is the entire comment-preservation path — `SqlToken.comments[]`
	 * entries ride alongside their owning token and we consult them at
	 * emit time, rather than trying to preserve raw inter-token
	 * whitespace (which the reflow explicitly regenerates).
	 */
	const emitComment = (raw: string, position: 'before' | 'after'): void => {
		const isLineComment = raw.startsWith('--') || raw.startsWith('//');
		if (position === 'before') {
			// Always break before a leading comment so it starts a fresh
			// line even when emitted consecutively (three `--` comments
			// in a row must stay on three lines, not concatenate).
			if (!atLineStart || parts.length === 0) emitNewline();
			parts.push(raw);
			atLineStart = false;
			// Force the token-that-follows onto a new line too.
			pendingNewline = true;
		} else {
			// After: hug the preceding token with a single space. If the
			// previous emit left a pendingNewline (e.g. the prior comment
			// was a line comment), break first so consecutive trailing line
			// comments land one per line instead of concatenating.
			if (pendingNewline) {
				emitNewline();
				pendingNewline = false;
			} else {
				emitSpace();
			}
			parts.push(raw);
			atLineStart = false;
			if (isLineComment) pendingNewline = true;
		}
	};

	for (let streamIndex = 0; streamIndex < stream.length; streamIndex++) {
		const tok = stream[streamIndex];
		if (tok.category === 'jinja') {
			// Jinja tokens carry `tagEnd` only on `*_open` entries; non-open
			// tokens are already consumed as part of their opener's span, so
			// skip them here to avoid double-emitting.
			if (tok.tagEnd === undefined) continue;
			// Suppress jinja tokens whose span is fully inside a SQL comment
			// — they're false positives from the independent Jinja tokenizer
			// (which doesn't know about `--` / `/*` delimiters).
			if (inAnyRange(tok.start, commentRanges)) continue;
			// Honor pendingNewline so Jinja tags between CTEs (and similar
			// boundary positions) land on their own line rather than gluing
			// onto the previous line with a leading space. The deferred
			// pendingBlankLine survives — it'll fire on the next emitNewline,
			// landing the blank line before the next CTE name as intended.
			if (pendingNewline) {
				const blankWasPending: boolean = pendingBlankLine;
				pendingBlankLine = false;
				emitNewline();
				pendingNewline = false;
				pendingBlankLine = blankWasPending;
			} else if (!atLineStart) {
				emitSpace();
			}
			// Keep pendingNewline alive while a blank-line is still owed —
			// the next non-Jinja token must break onto its own line so the
			// blank lands directly before it (e.g. before the next CTE name
			// when Jinja sits between CTEs).
			if (pendingBlankLine) pendingNewline = true;
			const rawTag = source.slice(tok.start, tok.tagEnd);
			parts.push(normaliseTagSpacing(rawTag) ?? rawTag);
			atLineStart = false;
			// Multi-line `{# ... #}` jinja comments end with `#}` on a fresh
			// line of the source, but the printer's verbatim emission leaves
			// us mid-line (the next SQL token would otherwise glue to `#}`,
			// e.g. `#} customer_agg as (`). Force a newline before the next
			// non-jinja token at top level so the SQL keeps its own line.
			if (tok.type === 'jinja_comment_open' && rawTag.includes('\n') && parenDepth === 0) {
				pendingNewline = true;
			}
			prev = tok;
			prevTypeUpper = 'JINJA';
			continue;
		}

		const typeUpper = tok.type.toUpperCase();
		const literal = source.slice(tok.start, tok.end + 1);

		// ── AST-informed role queries (hoisted) ───────────────────────────
		// `enclosing` is needed by the leading-comment drain below (to
		// detect tokens that will trigger a `+1` continuation indent) AND
		// by the per-shape role checks further down. Computing it once up
		// here is cheap (pure AST lookup) and avoids ordering hazards.
		const innermost = astIndex.empty ? undefined : astIndex.innermostClass(tok.start);
		const enclosing = astIndex.empty ? [] : astIndex.enclosingClasses(tok.start);

		// Trailing-operator hoist: under `operatorPosition: 'trailing'` an
		// AND/OR with a leading line comment would normally land on its own
		// line after the comment (`'tournament'\n-- note\nand case ...`),
		// which fails the trailing-position rule (`and` is at line start).
		// Hoist the AND/OR to trail the previous predicate's line FIRST,
		// then emit the leading comments, then let the operand continue on
		// a new indented line. We defer the comment drain below by flagging
		// it here; the post-emit branch reads the same flag to insert the
		// drained comments after the operator.
		const hasLeadingLineComment = tok.comments?.some(c =>
			c.start < tok.start && (source.slice(c.start, c.end).startsWith('--') || source.slice(c.start, c.end).startsWith('//')),
		) ?? false;
		const isPotentialPredicateBoolHoist =
			(typeUpper === 'AND' || typeUpper === 'OR')
			&& config.layout.operatorPosition === 'trailing'
			&& hasLeadingLineComment
			&& !skipNextTokenLeadingComments;

		// ── Leading comments ──────────────────────────────────────────────
		// Comments whose byte range precedes the owning token were attached
		// by sqlglot's tokenizer as "leading" — they belong ABOVE this
		// token in the output. Drain them now before the clause/spacing
		// logic runs, so they inherit the current indent level.
		//
		// Exception: when the prior CTE-separator-comma iteration (leading
		// mode) already drained THIS token's leading comments so they could
		// sit BETWEEN the CTEs, skip them here to avoid double-emission.
		// Also skip when we're hoisting a trailing-mode AND/OR — the comment
		// drain runs post-emit so the comments land below the operator.
		if (tok.comments?.length && !skipNextTokenLeadingComments && !isPotentialPredicateBoolHoist) {
			// Snapshot the one-shot extra indent queued by the previous
			// iteration (e.g. a select-list continuation comma sets
			// `oneShotExtraIndent = 1` so the next target lands at the +1
			// column). The first emitNewline inside emitComment consumes and
			// clears that value, so the post-drain emitNewline below would
			// otherwise land the SQL token at the base indent — exactly the
			// `indent-body` shape where a `-- comment` between projection
			// columns dedents the next column.
			//
			// When the upcoming token will itself trigger a `+1` continuation
			// indent (a leading-mode AND/OR in a predicate position, an
			// `indented_on`/`indented_then` keyword, etc.), the in-source
			// snapshot is 0 — pre-detect those shapes and treat them as if
			// the +1 had already been queued, so leading comments above the
			// continuation token sit at the SAME column as the continuation
			// itself rather than dropping back to the clause's base indent.
			const willBePredicateBool = (typeUpper === 'AND' || typeUpper === 'OR')
				&& (
					(
						(enclosing.includes('Where') || enclosing.includes('Having') || enclosing.includes('Join'))
						&& !hasInnerEnclosureAny(enclosing, ['Where', 'Having', 'Join'], ['Case', 'If'])
					)
					|| predicateBooleanOffsets.has(tok.start)
					|| inAnyRange(tok.start, multiPredicateJoinOnRanges)
				);
			const willBeJoinOnOrUsing = (typeUpper === 'ON' || typeUpper === 'USING') && policy.indentedOn
				&& (
					(enclosing.includes('Join') && (() => {
						const join = astIndex.findEnclosing(tok.start, 'Join');
						return !!join && astIndex.containsAny(join.start, join.end, ['And', 'Or']);
					})())
					|| inAnyRange(tok.start, multiPredicateJoinOnRanges)
				);
			const willTriggerContinuationIndent =
				(willBePredicateBool && config.layout.operatorPosition === 'leading')
				|| willBeJoinOnOrUsing
				|| (typeUpper === 'THEN'
					&& (enclosing.includes('Case') || enclosing.includes('If'))
					&& policy.indentedThen);
			const carriedExtraIndent = oneShotExtraIndent || (willTriggerContinuationIndent ? 1 : 0);
			for (const c of tok.comments) {
				if (c.start < tok.start) {
					// Restore the one-shot indent BEFORE each comment emit so
					// every line in a multi-line comment block lands at the
					// same column — the prior iteration's emitNewline consumed
					// the value, and without restoring it the second comment
					// drops back to the base indent.
					oneShotExtraIndent = carriedExtraIndent;
					emitComment(source.slice(c.start, c.end), 'before');
				}
			}
			if (pendingNewline) {
				// Restore the queued one-shot indent so the SQL token that
				// follows the comments lands at the SAME column the comments
				// themselves did, not at the base indent.
				oneShotExtraIndent = carriedExtraIndent;
				emitNewline();
				pendingNewline = false;
			}
		}
		skipNextTokenLeadingComments = false;

		// ── AST-informed role queries ─────────────────────────────────────
		// `innermost`/`enclosing` are computed above the leading-comment
		// drain; the per-shape detections below depend on them.
		// A CTE separator comma sits directly under a `With` (not inside
		// any paren/subquery/function inside the With). We detect by
		// checking: inside With AND not inside a Paren / Func / Subquery
		// ancestor that's a closer enclosure.
		//
		// AST fallback — sqlglot's serde leaves the outer `With` node's
		// `m` empty, so `enclosing.includes('With')` is false for real
		// parsed documents. We supplement with a token-stream flag
		// (`inWithClause`) that tracks "we've seen a top-level WITH but
		// not yet the final top-level SELECT", and require parenDepth==0
		// so commas inside CTE bodies / function calls / IN lists are
		// not mistaken for CTE separators.
		const isCteSeparatorComma = typeUpper === 'COMMA'
			&& (
				(enclosing.includes('With')
					&& !hasInnerEnclosure(enclosing, 'With', ['Paren', 'Func', 'Subquery', 'Anonymous']))
				|| (inWithClause && parenDepth === 0)
			);
		// A SELECT-list separator comma sits directly under a `Select`
		// (again not inside a nested enclosure). When the AST lacks position
		// metadata on Select nodes (common for CTE-body selects in sqlglot's
		// serde dump), fall back to the token-stream pre-pass that classifies
		// commas by tracking zone openings/closings off SELECT and FROM/WHERE.
		const isSelectListComma = typeUpper === 'COMMA'
			&& (
				(enclosing.includes('Select')
					&& !hasInnerEnclosure(enclosing, 'Select', ['Paren', 'Func', 'Subquery', 'Anonymous', 'Where', 'Group', 'Order', 'Having']))
				|| selectListCommaOffsets.has(tok.start)
			);
		// An L_PAREN opens an "indenting" span when it's a CTE body or a
		// subquery — those deserve their body on a new indented line.
		// Detection is token-stream-first (robust against AST variations
		// across sqlglot versions / dialects) with AST confirmation as
		// a fallback:
		//   - `base AS (...)`    → prev token is ALIAS → CTE body
		//   - `FROM (...)`       → prev token is FROM → subquery body
		//   - `JOIN (...)`       → prev token is JOIN → subquery body
		//   - `WHERE x IN (...)` → prev token is IN, and inner starts with
		//     SELECT → subquery body. IN-list of scalars (`IN ('a','b')`)
		//     stays inline (function-call-like paren).
		//   - `EXISTS (...)`     → prev token is EXISTS → subquery body
		// Function-call parens (`count(`, `coalesce(`) fail all of these
		// because their prev token is an identifier, not a keyword.
		const parenOpensIndent = typeUpper === 'L_PAREN'
			&& (astIndex.isCteOrSubqueryBodyOpen(tok.start)
				|| prevTypeUpper === 'ALIAS'
				|| prevTypeUpper === 'FROM'
				|| prevTypeUpper === 'JOIN'
				|| prevTypeUpper === 'EXISTS'
				|| ((prevTypeUpper === 'IN' || prevTypeUpper === 'NOT_IN')
					&& peekNextSqlTokenType(stream, streamIndex) === 'SELECT')
				// Scalar subquery after a comparison operator —
				// `where x = (select ...)`. Same shape as `IN (select ...)`:
				// the body deserves its own indented lines because the inner
				// SELECT can be arbitrarily wide. Gated on the next SQL token
				// being SELECT so `x = (1 + 2)` parens stay inline.
				|| (COMPARISON_OPS.has(prevTypeUpper)
					&& peekNextSqlTokenType(stream, streamIndex) === 'SELECT')
				// Wide `over (...)` window: indent the body so PARTITION BY
				// and ORDER BY land on their own lines. The matching R_PAREN
				// closes back to the outer column via the same indenting-
				// paren machinery used by CTE bodies.
				|| (prevTypeUpper === 'OVER' && mustWrapWindowParenStarts.has(tok.start)));
		void innermost;
		// An R_PAREN that closes the top indenting span needs a newline
		// BEFORE it so the close sits alone on its own de-indented line.
		const parenClosesIndent = typeUpper === 'R_PAREN'
			&& indentingParens.length > 0
			&& indentingParens[indentingParens.length - 1] === parenDepth;
		// An L_PAREN that follows an identifier is a function-call paren
		// and must hug the identifier (no space). The same rule applies
		// when the AST says we're inside a Func node: sqlglot tags those
		// parens explicitly.
		const functionCallParen = typeUpper === 'L_PAREN'
			&& (prevTypeUpper === 'VAR' || prevTypeUpper === 'IDENTIFIER'
				|| innermost === 'Func' || innermost === 'Anonymous');
		// `indented_on` / `indented_using` — an ON or USING keyword whose
		// enclosing node is a Join sits on a new indented line when the
		// predicate chain justifies it: multi-predicate ONs (containing
		// an AND/OR) break; single-comparison ONs (`on t.a = u.a`) stay
		// flush with the JOIN keyword, which is visually tighter and the
		// common preference. Respects the config toggle so users who want
		// ON always on its own line can set `indentedOn: true` and get
		// the legacy behavior, while the default stays compact.
		// `indented_on` multi-predicate split: AST path covers hand-built
		// fixtures where Join/And carry byte ranges; the token-stream
		// fallback covers real sqlglot output where Join.m is empty.
		let isJoinOnOrUsing = false;
		if ((typeUpper === 'ON' || typeUpper === 'USING') && policy.indentedOn) {
			if (enclosing.includes('Join')) {
				const join = astIndex.findEnclosing(tok.start, 'Join');
				if (join && astIndex.containsAny(join.start, join.end, ['And', 'Or'])) {
					isJoinOnOrUsing = true;
				}
			}
			if (!isJoinOnOrUsing && inAnyRange(tok.start, multiPredicateJoinOnRanges)) {
				isJoinOnOrUsing = true;
			}
		}
		// `indented_then` — a THEN keyword whose ancestor chain includes
		// `Case`/`If` lives on a new indented line, mirroring sqlfluff's
		// indented_then policy.
		const isIndentedThen = typeUpper === 'THEN'
			&& (enclosing.includes('Case') || enclosing.includes('If'))
			&& policy.indentedThen;
		// `indented_joins` — a JOIN start token whose parent is `From`
		// (top-level, not nested) indents one level deeper. This is an
		// alternative to placing JOINs flush with FROM; the config flag
		// gates it because the default matches sqlfluff's default.
		const isIndentedJoinStart = JOIN_START.has(typeUpper)
			&& !JOIN_CONTINUATION_PREV.has(prevTypeUpper)
			&& parenDepth === 0
			&& enclosing.includes('Join')
			&& policy.indentedJoins;
		// Boolean operators (AND/OR) wrap to their own line inside clauses
		// that carry predicates — Where, Having, Join ON conditions. The
		// direction is config.layout.operatorPosition: `leading` emits a
		// newline BEFORE the operator (the common default); `trailing`
		// emits it AFTER. The same +1 indent rule as indented_on keeps
		// the chained conditions visually aligned with each other.
		//
		// We exclude booleans inside Case/When bodies — those are part of
		// an expression, not a top-level predicate chain, and breaking
		// them would scramble CASE readability.
		const isPredicateBoolean = typeUpper === 'AND' || typeUpper === 'OR'
			? (
				(enclosing.includes('Where') || enclosing.includes('Having') || enclosing.includes('Join'))
					&& !hasInnerEnclosureAny(enclosing, ['Where', 'Having', 'Join'], ['Case', 'If'])
			) || predicateBooleanOffsets.has(tok.start)
				|| inAnyRange(tok.start, multiPredicateJoinOnRanges)
			: false;

		// ── Jinja → WITH boundary ─────────────────────────────────────────
		// A top-level `{{ ... }}` followed inline by `with` collides with the
		// CTE extractor (which scans the first `(` from line start and picks
		// up the Jinja paren) and triggers `ninja.layout.cte-bracket` on the
		// formatter's own output. Force a newline so the `with` clause owns
		// its line whenever a Jinja tag immediately precedes it at top level.
		if (typeUpper === 'WITH' && prevTypeUpper === 'JINJA' && parenDepth === 0 && !atLineStart) {
			pendingNewline = true;
		}

		// ── Clause/JOIN/set-op newline injection ──────────────────────────
		if (nonIndentingParenDepth === 0 && parts.length > 0) {
			if (MAJOR_CLAUSES.has(typeUpper) || SET_OPERATOR.has(typeUpper)) {
				// Trailing-comma policy: when the SELECT list wrapped (each target
				// on its own line) and we're about to emit the clause keyword that
				// ends the list, inject a trailing comma after the last target so
				// `convention.trailing-comma` stays clean on formatter output. The
				// previous token already landed inline; the comma hugs it before
				// the upcoming newline. SET_OPERATOR keywords (UNION/INTERSECT/
				// EXCEPT) end a SELECT list the same way major clauses do, so the
				// injection fires there too — required for FROM-first selects
				// where UNION is the only boundary after the targets.
				if (config.layout.commaPosition === 'trailing'
					&& prev && prev.category === 'sql'
					&& prevTypeUpper !== 'COMMA'
					&& isSelectListBoundary(prev.end, parenDepth, mustWrapSelectRanges)
					&& lastSqlPartsIdx >= 0
				) {
					// Splice immediately after the last SQL token's literal slot
					// (NOT plain push) so a leading comment attached to the
					// upcoming clause keyword — already drained into `parts` by
					// the leading-comment loop above — doesn't get separated
					// from its target token. Otherwise:
					//     last_target
					//     /* trailing block comment */
					//     ,
					// would result, re-triggering `convention.comma-position`
					// on the formatter's own output. With splice, the comma
					// lands on the same line as `last_target` before the
					// comment continues on its own line.
					parts.splice(lastSqlPartsIdx + 1, 0, ',');
				}
				// Clear any one-shot indent the last target-comma queued —
				// FROM/WHERE/etc land at the clause's base indent, not the
				// target-continuation indent.
				oneShotExtraIndent = 0;
				pendingNewline = true;
			} else if (JOIN_START.has(typeUpper) && !JOIN_CONTINUATION_PREV.has(prevTypeUpper)) {
				pendingNewline = true;
				if (isIndentedJoinStart) oneShotExtraIndent = 1;
			}
		}
		// AST-driven line breaks that can fire at ANY paren depth because
		// they follow node ancestry, not paren depth.
		if (isJoinOnOrUsing) {
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (isIndentedThen) {
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (isPredicateBoolean && config.layout.operatorPosition === 'leading') {
			// Break BEFORE the AND/OR so it leads the continuation line.
			// +1 indent puts the operator at the same depth as whatever
			// ON/WHERE/HAVING line it chains off, keeping the predicate
			// block visually coherent regardless of the parent clause's
			// own indent.
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (mustWrapWideExprOps.has(tok.start) && config.layout.operatorPosition === 'leading') {
			// Wide-expression arithmetic break (leading): break BEFORE the
			// top-level operator so it leads the continuation line. +1
			// indent puts the operand under the target's first line.
			// Triggered only when the target has no CASE/window/subquery
			// — those have their own wraps.
			pendingNewline = true;
			oneShotExtraIndent = 1;
		}
		// A CTE separator comma always breaks, even when nested inside the
		// WITH's top paren — that's the whole reason we need AST context
		// over pure paren-depth tracking.
		if (isCteSeparatorComma) {
			if (config.layout.commaPosition === 'leading') {
				// Leading mode: break BEFORE the comma so it leads the next
				// CTE definition (`)\n\n, next_cte as (...)`). Push a literal
				// `\n` first to insert the blank-line between CTEs.
				parts.push('\n');
				// If the next SQL token carries leading comments (e.g. `--
				// comment\n next_cte as (`), drain those FIRST so the block
				// sits between the CTEs and the comma lands on the same line
				// as the identifier. Without this, `, ` would land alone on
				// a line and the comment would push the identifier off-line,
				// re-triggering `convention.comma-position`.
				const nextSqlTok = peekNextSqlToken(stream, streamIndex);
				if (nextSqlTok?.comments?.length) {
					for (const c of nextSqlTok.comments) {
						if (c.start < nextSqlTok.start) {
							emitComment(source.slice(c.start, c.end), 'before');
						}
					}
					// pendingNewline may have been set by emitComment; clear
					// it so we don't double-break before the comma. The next
					// emitNewline below puts the comma on a fresh line.
					pendingNewline = false;
					skipNextTokenLeadingComments = true;
				}
				// Queue the regular newline so the comma lands flush at the
				// outer indent on a fresh line. Post-emit blank-line
				// injection is suppressed below.
				pendingNewline = true;
			}
			// Trailing mode: comma stays flush against the preceding `)` token;
			// blank line + newline for the next CTE name fire AFTER the emit.
		}

		// Leading-comma mode: when a SELECT list must wrap, emit a newline
		// BEFORE the comma so it leads the continuation line. Short lists
		// stay inline unchanged. One-shot extra indent keeps the commas
		// visually aligned with subsequent targets.
		if (isSelectListComma
			&& config.layout.commaPosition === 'leading'
			&& inAnyRange(tok.start, mustWrapSelectRanges)
		) {
			// If the next target carries leading comments (block or `--`),
			// drain them BEFORE the comma so the comma stays adjacent to the
			// identifier: `\n    -- comment\n    , next_target`. Otherwise
			// the comment would land between the comma and the target,
			// stranding the comma at the end of its line and re-triggering
			// `convention.comma-position`. Mirrors the CTE-separator
			// handling above.
			const nextSqlTok = peekNextSqlToken(stream, streamIndex);
			if (nextSqlTok?.comments?.length && nextSqlTok.comments.some(c => c.start < nextSqlTok.start)) {
				// Open the continuation line for the comment first so it
				// sits at the +1-indented target column.
				pendingNewline = true;
				oneShotExtraIndent = 1;
				emitNewline();
				for (const c of nextSqlTok.comments) {
					if (c.start < nextSqlTok.start) {
						// Each comment line needs the +1 continuation indent
						// re-applied — the previous emitComment's internal
						// emitNewline consumed the one-shot, so without
						// restoring it the next comment would drop back to
						// the base indent.
						oneShotExtraIndent = 1;
						emitComment(source.slice(c.start, c.end), 'before');
					}
				}
				skipNextTokenLeadingComments = true;
				// emitComment will have queued its own pendingNewline; clear
				// it so the comma below sits on a fresh line via our own
				// emitNewline call (and so trailing-line comments don't
				// double-break).
				pendingNewline = false;
			}
			pendingNewline = true;
			oneShotExtraIndent = 1;
		}

		// ── Wide-CASE expression wrap ──────────────────────────────────────
		// CASE expressions whose flat single-line projection exceeds the
		// configured max length are rendered with `when`/`else`/`end` on
		// their own lines (each WHEN/ELSE one indent deeper than CASE; END
		// flush with CASE). Triggered by `computeMustWrapCases`. The actual
		// indent bump happens in the post-emit branch for CASE; here we
		// just queue the per-keyword breaks.
		//
		// `caseStack.length === nestedCaseDepth` means the current open CASE
		// level corresponds to the top wide-CASE entry. WHEN/ELSE inside a
		// wide CASE break before the keyword; nested non-wide CASE keywords
		// stay inline because their level has no matching stack entry.
		const isInsideWideCase = caseStack.length > 0
			&& nestedCaseDepth > 0
			&& caseIsWide[nestedCaseDepth - 1] === true;
		if (isInsideWideCase && (typeUpper === 'WHEN' || typeUpper === 'ELSE')) {
			pendingNewline = true;
		}
		// Wide-THEN body wrap: when the just-emitted THEN's start is in
		// `mustBreakAfterThenOffsets`, the result expression follows on its
		// own line one indent deeper than THEN's column. Fires for the
		// FIRST token after THEN (the start of the result expression);
		// subsequent tokens flow inline until the next WHEN/ELSE/END break.
		// Skip when the next token IS the closing keyword (defensive: would
		// otherwise insert an empty indented line before WHEN/ELSE/END,
		// although in practice a THEN with empty body shouldn't trigger
		// the must-break heuristic).
		if (prev && prev.category === 'sql' && prevTypeUpper === 'THEN'
			&& mustBreakAfterThenOffsets.has(prev.start)
			&& typeUpper !== 'WHEN' && typeUpper !== 'ELSE' && typeUpper !== 'END'
		) {
			pendingNewline = true;
			oneShotExtraIndent = 1;
		}
		// END for a wide CASE: pop the stack BEFORE the newline so the END
		// lands at CASE's column. The depth check ensures we only pop when
		// the END matches the current wide level (nested non-wide CASEs pop
		// `nestedCaseDepth` but not `caseStack`).
		const closesWideCase = typeUpper === 'END'
			&& nestedCaseDepth > 0
			&& caseIsWide[nestedCaseDepth - 1] === true;
		if (closesWideCase) {
			const restore = caseStack.pop()!;
			caseIsWide.pop();
			nestedCaseDepth--;
			indentLevel = restore.savedIndent;
			oneShotExtraIndent = restore.savedExtra;
			pendingNewline = true;
		}

		// Close-paren for a CTE body / subquery gets its own line at the
		// outer indent. We decrement `indentLevel` BEFORE the newline so
		// the paren lands flush with the CTE's `as`, not with its body.
		if (parenClosesIndent) {
			const top = indentingParens[indentingParens.length - 1];
			if (top === parenDepth) {
				indentingParens.pop();
				const extra = indentingParenExtras.pop() ?? 0;
				const wasWindow = indentingParenIsWindow.pop() ?? false;
				indentLevel = Math.max(0, indentLevel - 1 - extra);
				// Wide-window `over (...)` close lands at the SAME column as
				// the `over (` line (the select-list-continuation column),
				// not the outer base. Restoring `+extra` for the R_PAREN's
				// emit produces the canonical sqlfluff layout where `) as
				// alias` aligns with the function call's `over`. Other
				// indenting parens (CTE bodies, subqueries, IN-subqueries)
				// close at the outer base regardless of the opener's
				// continuation indent — that's the established convention.
				if (wasWindow && extra > 0) oneShotExtraIndent = extra;
			}
			pendingNewline = true;
		}

		// Hoist: suppress the pre-emit newline so AND/OR trails the previous
		// predicate's line. We'll emit the deferred leading comments after
		// the operator and let post-emit logic break before the operand.
		if (isPotentialPredicateBoolHoist) {
			pendingNewline = false;
		}

		if (pendingNewline) {
			emitNewline();
			pendingNewline = false;
		}

		// ── Spacing decision ──────────────────────────────────────────────
		const noSpaceBefore = NO_SPACE_BEFORE.has(typeUpper) || functionCallParen;
		const prevNoSpaceAfter = prev && prev.category === 'sql' && NO_SPACE_AFTER.has(prevTypeUpper);
		const needSpace = !atLineStart && !noSpaceBefore && !prevNoSpaceAfter;
		if (needSpace) emitSpace();

		// ── Emit the token ────────────────────────────────────────────────
		// Peek forward for the next SQL token's type so function-call
		// detection (VAR + L_PAREN) works. Skip jinja tokens while
		// peeking — they don't change the "is this a function call"
		// answer.
		let nextSqlTypeUpper: string | undefined;
		for (let j = streamIndex + 1; j < stream.length; j++) {
			const next = stream[j];
			if (next.category === 'sql') {
				nextSqlTypeUpper = next.type.toUpperCase();
				break;
			}
		}
		// `convention.union-style` parity: rewrite the qualifier after UNION so
		// the formatter output matches the configured style (e.g. `union all`
		// when `unionStyle: 'all'`). The rule itself has a surgical fix, but
		// keeping the reflow output canonical means full-document format runs
		// don't leave the rule firing on their own output.
		let emitLiteral = literal;
		let emitType = tok.type;
		if (prevTypeUpper === 'UNION' && (typeUpper === 'ALL' || typeUpper === 'DISTINCT')) {
			const preferred = config.convention.unionStyle === 'all' ? 'ALL' : 'DISTINCT';
			if (typeUpper !== preferred) {
				// Preserve literal case via recaseToken below by swapping the
				// raw text; the token TYPE is updated so recasing uses the
				// keyword policy on the replacement.
				emitLiteral = preferred;
				emitType = preferred;
			}
		}
		parts.push(recaseToken(emitType, emitLiteral, config, cap, nextSqlTypeUpper));
		lastSqlPartsIdx = parts.length - 1;
		atLineStart = false;

		// ── Trailing comments ────────────────────────────────────────────
		// Any comment whose byte range sits AFTER this token's span was
		// attached as trailing — emit inline. Line comments force a newline
		// after so the next token doesn't get swallowed into the comment.
		if (tok.comments?.length) {
			for (const c of tok.comments) {
				if (c.start > tok.end) {
					emitComment(source.slice(c.start, c.end), 'after');
				}
			}
		}

		// ── Post-token paren / line-end effects ───────────────────────────
		if (typeUpper === 'L_PAREN') {
			parenDepth++;
			if (parenOpensIndent) {
				// If the line carrying this `(` was already a continuation
				// (e.g. an `in (` at the tail of a multi-AND JOIN ON chain
				// inside a CTE body — that line consumed
				// `oneShotExtraIndent = 1` at its newline), the body inside
				// the paren needs to land DEEPER than `indentLevel + 1` —
				// otherwise the body's first line lines up with the
				// continuation AND/OR siblings rather than nesting under
				// them. Carry the consumed continuation indent into the
				// scope so it adds to the body's base column. The matching
				// close subtracts the same delta.
				const extra = currentLineExtraIndent;
				indentLevel += 1 + extra;
				indentingParens.push(parenDepth);
				indentingParenExtras.push(extra);
				indentingParenIsWindow.push(
					prevTypeUpper === 'OVER' && mustWrapWindowParenStarts.has(tok.start),
				);
				pendingNewline = true;
			} else {
				// Function call, grouping, IN list — suppresses clause breaks
				// until the matching close.
				nonIndentingParenDepth++;
			}
		} else if (typeUpper === 'R_PAREN') {
			// Indenting-paren pop + dedent is handled up-front before the
			// emit (via `parenClosesIndent`). For non-indenting parens we
			// decrement here so the suppression lifts at the matching close.
			if (!parenClosesIndent && nonIndentingParenDepth > 0) {
				nonIndentingParenDepth--;
			}
			parenDepth = Math.max(0, parenDepth - 1);
		} else if (typeUpper === 'SEMICOLON') {
			pendingNewline = true;
		} else if (typeUpper === 'CASE') {
			// Open a new CASE level. If the pre-pass flagged THIS CASE as
			// wide, push state onto `caseStack` and bump indent so the
			// upcoming WHEN/ELSE land one level deeper than CASE. The first
			// WHEN's break comes from the pendingNewline below; subsequent
			// WHEN/ELSE break via the `isInsideWideCase` pre-emit logic.
			//
			// `savedExtra = currentLineExtraIndent` captures the +1
			// continuation that select-list wrap put on the CASE-bearing
			// line. We add it to the indent bump so WHEN lands one deeper
			// than CASE's effective column, and we restore it on END so
			// END lands at CASE's column (not the SELECT body's base).
			nestedCaseDepth++;
			const wide = mustWrapCaseStarts.has(tok.start);
			caseIsWide.push(wide);
			if (wide) {
				const savedExtra = currentLineExtraIndent;
				caseStack.push({ savedIndent: indentLevel, savedExtra });
				indentLevel += 1 + savedExtra;
				pendingNewline = true;
			}
		} else if (typeUpper === 'END' && nestedCaseDepth > 0 && !closesWideCase) {
			// Non-wide CASE: pop the nesting counter alone — `caseStack` was
			// never pushed for this level. (Wide-case END is handled fully
			// in the pre-emit branch above, which pops all three.)
			nestedCaseDepth--;
			caseIsWide.pop();
		}

		// Track top-level WITH ... SELECT scope for the CTE-separator
		// fallback. Done after the emit so the current token sees the
		// pre-transition state (irrelevant for WITH/SELECT themselves
		// since neither is a comma).
		if (typeUpper === 'WITH' && parenDepth === 0) {
			inWithClause = true;
		} else if (typeUpper === 'SELECT' && parenDepth === 0 && inWithClause) {
			inWithClause = false;
		}

		if (isCteSeparatorComma) {
			if (config.layout.commaPosition !== 'leading') {
				// Trailing mode: insert a blank line between CTE definitions.
				// Use the deferred `pendingBlankLine` flag so the blank line
				// rides through any intervening Jinja tags and lands
				// immediately before the NEXT CTE name's line. Without the
				// deferral the blank would sit right after the comma, and a
				// `{% if %} ... {% endif %}` between CTEs would absorb it,
				// leaving no blank above the next CTE name and re-triggering
				// `ninja.layout.cte-blank-line` on the formatter's own output.
				pendingBlankLine = true;
				pendingNewline = true;
			}
		} else if (isSelectListComma) {
			// Break only when the Select will overflow the line. Short
			// `select a, b from t` stays on one line; long SELECT lists wrap.
			// `commaPosition: 'leading'` is handled BEFORE the comma emission
			// (see earlier in the loop); trailing fires here, after.
			const mustWrap = inAnyRange(tok.start, mustWrapSelectRanges);
			if (mustWrap && config.layout.commaPosition === 'trailing') {
				pendingNewline = true;
				// Indent continuation targets so they sit under the first one.
				oneShotExtraIndent = 1;
			}
		} else if ((isPredicateBoolean || isPotentialPredicateBoolHoist) && config.layout.operatorPosition === 'trailing') {
			// Trailing mode: the AND/OR already landed inline at the end of
			// the previous predicate's line; break AFTER it so the next
			// predicate starts a new indented line.
			//
			// Hoist case: leading-line comments that were deferred (so AND/OR
			// could trail the prev line) get drained here, between the
			// operator and the operand. The comments land below AND/OR but
			// above the operand at the operand's continuation indent.
			if (isPotentialPredicateBoolHoist && tok.comments?.length) {
				pendingNewline = true;
				oneShotExtraIndent = 1;
				emitNewline();
				pendingNewline = false;
				for (const c of tok.comments) {
					if (c.start < tok.start) {
						emitComment(source.slice(c.start, c.end), 'before');
					}
				}
			}
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (typeUpper === 'SELECT' && inAnyRange(tok.start, mustWrapSelectRanges)) {
			// Wrap mode: break BEFORE the first target so all targets land
			// on their own indented lines. Subsequent targets are broken by
			// the comma path above. Keeps the wrap shape consistent whether
			// the trigger is line-length overflow or a future explicit
			// `always wrap` policy.
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (mustWrapWideExprOps.has(tok.start) && config.layout.operatorPosition === 'trailing') {
			// Wide-expression arithmetic break (trailing): the operator
			// already landed inline at the end of the previous line; break
			// AFTER it so the next operand starts a fresh continuation
			// line at +1 indent.
			pendingNewline = true;
			oneShotExtraIndent = 1;
		}

		prev = tok;
		prevTypeUpper = typeUpper;
	}

	// End-of-stream trailing-comma injection. The in-loop trailing-comma logic
	// anchors on the major-clause / set-operator that follows the SELECT list
	// (FROM, WHERE, UNION, ...). When the SELECT list runs to end-of-stream
	// (no clause keyword after — e.g. a FROM-first SELECT whose last branch
	// is the final statement), there's no anchor and the last target lands
	// without its comma. Splice the comma immediately after the last SQL
	// token's literal so it lands BEFORE any trailing comments attached to
	// that token.
	if (config.layout.commaPosition === 'trailing'
		&& prev && prev.category === 'sql'
		&& prevTypeUpper !== 'COMMA'
		&& lastSqlPartsIdx >= 0
		&& isSelectListBoundary(prev.end, parenDepth, mustWrapSelectRanges)
	) {
		parts.splice(lastSqlPartsIdx + 1, 0, ',');
	}

	void indentLevel;

	let output = parts.join('');

	// Collapse trailing whitespace on each line — the only line-level trivia
	// worth enforcing unconditionally.
	output = output.replace(/[ \t]+$/gm, '');
	// Normalize any CRLF that leaked through (from comment-token source text)
	// — the printer emits its own breaks as LF, so a mixed-EOL output trips
	// the trailing-newline rule's EOL-detection heuristic.
	output = output.replace(/\r\n/g, '\n');
	// Always end with a single trailing newline.
	if (!output.endsWith('\n')) output += '\n';
	return output;
}

/**
 * Token-stream pass that locates every CASE...END expression that sits in
 * a context where the surrounding SELECT-list target would overflow
 * `maxLineLength` if rendered on a single line. Returns a set of
 * CASE-token `start` offsets — the printer checks membership at the CASE
 * emit point to decide whether to enter wide-CASE mode (one WHEN/ELSE per
 * line, END flush with CASE).
 *
 * Why a token-stream pass rather than AST: sqlglot's serde frequently drops
 * `m` (position metadata) on `Case` nodes inside expressions, so
 * `findEnclosing(... 'Case')` can't recover the CASE's byte range. The
 * token stream has every CASE/WHEN/END token with its source position
 * intact, which is sufficient for a width estimate.
 *
 * ## Why target-width, not CASE-width
 *
 * Measuring just the CASE...END span underestimates the actual line width
 * because the SELECT target wraps each column onto its own line:
 *   `        , case when X then Y else Z end as some_column_alias`
 * The CASE-only width may fit, but the rendered line (indent + comma
 * prefix + CASE...END + ` as alias`) overflows. We instead measure the
 * full SELECT target containing the CASE.
 *
 * ## Algorithm
 *
 *   1. Track SELECT zones (same logic as computeSelectListCommas): each
 *      SELECT opens a zone at its paren depth; commas at that depth are
 *      target separators; clause keywords / R_PAREN close the zone.
 *   2. Inside a zone, accumulate per-target width since the last separator
 *      (or zone start). Record every CASE-token start offset seen.
 *   3. At each separator (comma or clause-keyword close), if the target's
 *      projected width (indent + width + inter-token spaces) exceeds
 *      `maxLineLength`, mark all the CASEs in that target as wide.
 *
 * Nested CASE: a wide outer CASE that contains a non-wide inner CASE will
 * have BOTH marked wide — they share a target. That's the desired
 * behaviour: once we're wrapping the outer CASE, wrapping the inner one
 * too keeps the readability proportional to depth.
 */
function computeMustWrapCases(
	stream: NinjaSqlToken[],
	maxLineLength: number,
	policy: IndentPolicy,
): Set<number> {
	const out = new Set<number>();
	const indentWidth = policy.at(1).length || 4;

	// Same indent-tracking heuristic as computeMustWrapSelects.
	let parenDepth = 0;
	let indentLevel = 0;
	const indentingParens: number[] = [];
	let prevSqlType = '';

	// Stack of active SELECT zones. Each tracks the target accumulator: the
	// CASE-starts seen since the last separator, plus the running width.
	// `baseIndentLevel` is the indent at the zone's SELECT — since the
	// printer's select-list wrap adds +1 to that for each target, we use
	// `baseIndentLevel + 1` as the column reference for the target width.
	type Zone = {
		openedAtDepth: number;
		baseIndentLevel: number;
		// In-progress accumulator for the current target (resets at each
		// separator).
		curWidth: number;
		curTokenCount: number;
		curCaseStarts: number[];
	};
	const zones: Zone[] = [];

	const flushTarget = (zone: Zone): void => {
		if (zone.curCaseStarts.length === 0) {
			zone.curWidth = 0;
			zone.curTokenCount = 0;
			return;
		}
		const projected = (zone.baseIndentLevel + 1) * indentWidth
			+ zone.curWidth
			+ Math.max(0, zone.curTokenCount - 1);
		if (projected > maxLineLength) {
			for (const s of zone.curCaseStarts) out.add(s);
		}
		zone.curWidth = 0;
		zone.curTokenCount = 0;
		zone.curCaseStarts = [];
	};

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		// Jinja regions are emitted verbatim by the printer, so they
		// contribute to line width — accumulate them into the current
		// SELECT target. Only `*_open` jinja tokens carry `tagEnd` (the
		// other categories are members of the open's span); we use the
		// open-to-close character delta as the width contribution.
		if (tok.category === 'jinja') {
			if (tok.tagEnd === undefined) continue;
			const litWidth = tok.tagEnd - tok.start;
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += litWidth;
				z.curTokenCount++;
			}
			continue;
		}
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			const isIndenting = isIndentingParenOpen(stream, i, prevSqlType);
			if (isIndenting) {
				indentLevel++;
				indentingParens.push(parenDepth);
			}
			// Accumulate the paren into the innermost zone's current target.
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += tok.end - tok.start + 1;
				z.curTokenCount++;
			}
			prevSqlType = type;
			continue;
		}
		if (type === 'R_PAREN') {
			// A close-paren may close any zones whose openedAtDepth is now
			// deeper than the outer paren depth — flush each first.
			parenDepth = Math.max(0, parenDepth - 1);
			while (zones.length > 0 && zones[zones.length - 1].openedAtDepth > parenDepth) {
				flushTarget(zones[zones.length - 1]);
				zones.pop();
			}
			if (indentingParens.length > 0 && indentingParens[indentingParens.length - 1] === parenDepth + 1) {
				indentingParens.pop();
				indentLevel = Math.max(0, indentLevel - 1);
			}
			// Accumulate into the (now possibly-different) innermost zone.
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += tok.end - tok.start + 1;
				z.curTokenCount++;
			}
			prevSqlType = type;
			continue;
		}

		if (type === 'SELECT') {
			zones.push({
				openedAtDepth: parenDepth,
				baseIndentLevel: indentLevel,
				curWidth: 0,
				curTokenCount: 0,
				curCaseStarts: [],
			});
			prevSqlType = type;
			continue;
		}

		if (zones.length > 0) {
			const z = zones[zones.length - 1];
			// Target boundary at the active zone's depth: flush, then start a
			// new target. The clause-keyword case ALSO closes the zone.
			if (parenDepth === z.openedAtDepth) {
				if (type === 'COMMA') {
					flushTarget(z);
					prevSqlType = type;
					continue;
				}
				if (SELECT_LIST_END_KEYWORDS.has(type)) {
					flushTarget(z);
					zones.pop();
					prevSqlType = type;
					continue;
				}
			}
			// Otherwise, accumulate the token into the current target.
			z.curWidth += tok.end - tok.start + 1;
			z.curTokenCount++;
			if (type === 'CASE') {
				z.curCaseStarts.push(tok.start);
			}
		}

		prevSqlType = type;
	}

	// End-of-stream: flush whatever's still pending.
	while (zones.length > 0) {
		flushTarget(zones[zones.length - 1]);
		zones.pop();
	}

	return out;
}

/**
 * Token-stream pass that finds THEN keywords inside already-wrapped CASE
 * expressions whose `when COND then RESULT` line would still overflow
 * `maxLineLength`. Returns a set of THEN `start` offsets. The walker uses
 * this to force a newline + extra indent before the result expression so
 * it lands on its own line under THEN.
 *
 * Algorithm: maintain a stack of open CASE byte ranges with the paren
 * depth at which the CASE opened. For each THEN whose enclosing CASE start
 * is in `mustWrapCaseStarts`:
 *
 *   1. Walk backward from THEN to the previous WHEN (or CASE for the
 *      first WHEN) at the same paren depth as THEN. Sum literal widths +
 *      one space per inter-token gap. That's the prefix.
 *   2. Walk forward from THEN to the next WHEN/ELSE/END at the same paren
 *      depth. Sum literal widths + spaces. That's the result expression.
 *   3. Approximate indent column as `policy.size * 2` — the SELECT-target
 *      column plus one CASE-body indent. (The actual column may differ for
 *      deeply nested cases but the approximation is conservative; the
 *      printer's wide-CASE pass already pushed CASE itself onto its own
 *      line, so we are measuring relative to that body indent.)
 *   4. Total = indent + prefix + ` then ` + result. If > maxLineLength,
 *      mark THEN's start offset.
 */
function computeMustBreakAfterThens(
	stream: NinjaSqlToken[],
	mustWrapCaseStarts: Set<number>,
	maxLineLength: number,
	policy: IndentPolicy,
): Set<number> {
	const out = new Set<number>();
	if (mustWrapCaseStarts.size === 0) return out;
	const indentWidth = policy.at(1).length || 4;

	// Sqlglot's tokenizer emits `THEN` (or `ELSE`/`END`) at any paren depth
	// the source uses. We track paren depth and the stack of currently-open
	// CASEs (start offset + paren depth where CASE opened + whether the
	// `indent-body` engine would consider the surrounding scope "governed"
	// by a clause keyword). A given THEN belongs to the innermost open CASE
	// whose openDepth matches the THEN's current paren depth.
	//
	// `clauseAtDepth` mirrors `indent-body-engine.ts`'s `clauseStack`:
	// L_PAREN pushes an empty entry (undefined), R_PAREN pops, and CLAUSE
	// keywords overwrite the entry at the current depth. If a CASE opens
	// while the top-of-stack is defined (e.g. SELECT in scope without a
	// sheltering inner paren), breaking-after-THEN would place result
	// content at a column the indent-body engine doesn't expect, producing
	// a false `indent-body` violation on the formatter's own output. The
	// `hasClauseGovernor` flag captured at CASE open is used to gate the
	// break.
	const clauseAtDepth: Array<boolean> = [false];
	const caseStack: Array<{ start: number; depth: number; hasClauseGovernor: boolean }> = [];
	let parenDepth = 0;

	const CLAUSE_KEYWORDS = new Set([
		'SELECT', 'FROM', 'WHERE', 'HAVING',
		'GROUP_BY', 'GROUP', 'ORDER_BY', 'ORDER',
		'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW',
	]);

	const litWidth = (i: number): number => {
		const t = stream[i];
		if (t.category === 'jinja') {
			return t.tagEnd === undefined ? 0 : t.tagEnd - t.start;
		}
		return t.end - t.start + 1;
	};

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category === 'jinja') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			clauseAtDepth.push(false);
			continue;
		}
		if (type === 'R_PAREN') {
			parenDepth = Math.max(0, parenDepth - 1);
			if (clauseAtDepth.length > 1) clauseAtDepth.pop();
			continue;
		}
		if (CLAUSE_KEYWORDS.has(type)) {
			clauseAtDepth[clauseAtDepth.length - 1] = true;
		}
		if (type === 'CASE') {
			caseStack.push({
				start: tok.start,
				depth: parenDepth,
				hasClauseGovernor: clauseAtDepth[clauseAtDepth.length - 1],
			});
			continue;
		}
		if (type === 'END') {
			if (caseStack.length > 0) caseStack.pop();
			continue;
		}
		if (type !== 'THEN') continue;

		// Find the innermost open CASE at this THEN's paren depth.
		let enclosing: { start: number; depth: number; hasClauseGovernor: boolean } | undefined;
		for (let k = caseStack.length - 1; k >= 0; k--) {
			if (caseStack[k].depth === parenDepth) {
				enclosing = caseStack[k];
				break;
			}
		}
		if (!enclosing || !mustWrapCaseStarts.has(enclosing.start)) continue;
		// Gate: only break-after-THEN when the enclosing CASE opened at a
		// paren level WITHOUT an active clause governor (i.e. inside `round(`
		// or `(` directly under FROM, etc., where `indent-body-engine`'s
		// clauseStack top is `undefined`). For a CASE opened directly under
		// a clause keyword like SELECT, the broken result expression would
		// land at col `selectCol + 3*indentSize` — three indents deep — but
		// `ninja.layout.indent-body` expects clause-body content at
		// `selectCol + 1`, producing a false violation on formatter output.
		if (enclosing.hasClauseGovernor) continue;

		// Walk backward to previous WHEN (or CASE) at the SAME paren depth.
		// Track a synthetic depth tracker because we're scanning across an
		// arbitrary range that may itself contain nested parens.
		let prefixWidth = 0;
		let prefixTokens = 0;
		{
			let depth = parenDepth;
			for (let j = i - 1; j >= 0; j--) {
				const t = stream[j];
				if (t.category === 'jinja') {
					prefixWidth += litWidth(j);
					prefixTokens++;
					continue;
				}
				const tt = t.type.toUpperCase();
				if (tt === 'R_PAREN') { depth++; }
				else if (tt === 'L_PAREN') { depth = Math.max(0, depth - 1); }
				if (depth === parenDepth && (tt === 'WHEN' || tt === 'CASE')) break;
				prefixWidth += litWidth(j);
				prefixTokens++;
			}
		}

		// Walk forward to next WHEN/ELSE/END at the same paren depth.
		let resultWidth = 0;
		let resultTokens = 0;
		{
			let depth = parenDepth;
			for (let j = i + 1; j < stream.length; j++) {
				const t = stream[j];
				if (t.category === 'jinja') {
					resultWidth += litWidth(j);
					resultTokens++;
					continue;
				}
				const tt = t.type.toUpperCase();
				if (tt === 'L_PAREN') { depth++; }
				else if (tt === 'R_PAREN') { depth = Math.max(0, depth - 1); }
				if (depth === parenDepth && (tt === 'WHEN' || tt === 'ELSE' || tt === 'END')) break;
				resultWidth += litWidth(j);
				resultTokens++;
			}
		}

		// Indent column for the WHEN-line inside a wide CASE: SELECT-target
		// (+1) plus CASE-body (+1) = 2 indent steps. Conservative — the
		// actual column may be deeper for nested cases but we only need a
		// floor to know "this line definitely overflows".
		const indent = indentWidth * 2;
		const whenLit = 4; // "when"
		const thenLit = 4; // "then"
		// `when <prefix> then <result>` — inter-token spaces:
		// 1 between "when" and prefix, (prefixTokens - 1) inside prefix,
		// 1 between prefix and "then", 1 between "then" and result,
		// (resultTokens - 1) inside result.
		const spaces = 1 + Math.max(0, prefixTokens - 1) + 1 + 1 + Math.max(0, resultTokens - 1);
		const total = indent + whenLit + prefixWidth + thenLit + resultWidth + spaces;
		if (total > maxLineLength) out.add(tok.start);
	}

	return out;
}

/**
 * Token-stream pass that locates `over (...)` window-function parens
 * whose containing SELECT target would overflow `maxLineLength` on a
 * single line. Returns a set of L_PAREN `start` offsets (the `(` right
 * after `OVER`). When membership matches at walk time, the paren is
 * treated as an indenting paren so the window body wraps onto its own
 * indented lines with breaks before PARTITION_BY and ORDER_BY.
 *
 * Same SELECT-target width measurement as `computeMustWrapCases`: each
 * SELECT opens a target accumulator; the OVER-paren is marked when the
 * accumulator at separator time exceeds the line limit.
 */
function computeMustWrapWindows(
	stream: NinjaSqlToken[],
	maxLineLength: number,
	policy: IndentPolicy,
): Set<number> {
	const out = new Set<number>();
	const indentWidth = policy.at(1).length || 4;

	let parenDepth = 0;
	let indentLevel = 0;
	const indentingParens: number[] = [];
	let prevSqlType = '';

	type Zone = {
		openedAtDepth: number;
		baseIndentLevel: number;
		curWidth: number;
		curTokenCount: number;
		// L_PAREN starts that are window `(` (preceded by OVER) within the
		// current target. Multiple windows per target is rare but allowed.
		curWindowParens: number[];
	};
	const zones: Zone[] = [];

	const flushTarget = (zone: Zone): void => {
		if (zone.curWindowParens.length > 0) {
			const projected = (zone.baseIndentLevel + 1) * indentWidth
				+ zone.curWidth
				+ Math.max(0, zone.curTokenCount - 1);
			if (projected > maxLineLength) {
				for (const p of zone.curWindowParens) out.add(p);
			}
		}
		zone.curWidth = 0;
		zone.curTokenCount = 0;
		zone.curWindowParens = [];
	};

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category === 'jinja') {
			if (tok.tagEnd === undefined) continue;
			const litWidth = tok.tagEnd - tok.start;
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += litWidth;
				z.curTokenCount++;
			}
			continue;
		}
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			const isIndenting = isIndentingParenOpen(stream, i, prevSqlType);
			if (isIndenting) {
				indentLevel++;
				indentingParens.push(parenDepth);
			}
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += tok.end - tok.start + 1;
				z.curTokenCount++;
				if (prevSqlType === 'OVER') z.curWindowParens.push(tok.start);
			}
			prevSqlType = type;
			continue;
		}
		if (type === 'R_PAREN') {
			parenDepth = Math.max(0, parenDepth - 1);
			while (zones.length > 0 && zones[zones.length - 1].openedAtDepth > parenDepth) {
				flushTarget(zones[zones.length - 1]);
				zones.pop();
			}
			if (indentingParens.length > 0 && indentingParens[indentingParens.length - 1] === parenDepth + 1) {
				indentingParens.pop();
				indentLevel = Math.max(0, indentLevel - 1);
			}
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += tok.end - tok.start + 1;
				z.curTokenCount++;
			}
			prevSqlType = type;
			continue;
		}

		if (type === 'SELECT') {
			zones.push({
				openedAtDepth: parenDepth,
				baseIndentLevel: indentLevel,
				curWidth: 0,
				curTokenCount: 0,
				curWindowParens: [],
			});
			prevSqlType = type;
			continue;
		}

		if (zones.length > 0) {
			const z = zones[zones.length - 1];
			if (parenDepth === z.openedAtDepth) {
				if (type === 'COMMA') {
					flushTarget(z);
					prevSqlType = type;
					continue;
				}
				if (SELECT_LIST_END_KEYWORDS.has(type)) {
					flushTarget(z);
					zones.pop();
					prevSqlType = type;
					continue;
				}
			}
			z.curWidth += tok.end - tok.start + 1;
			z.curTokenCount++;
		}

		prevSqlType = type;
	}

	while (zones.length > 0) {
		flushTarget(zones[zones.length - 1]);
		zones.pop();
	}

	return out;
}

/**
 * Locate SELECT targets whose single-line projection exceeds `maxLineLength`
 * and that consist of a single arithmetic expression (no CASE, no window,
 * no scalar subquery). For each such target, pick the lowest-precedence
 * top-level binary operator (PLUS/MINUS preferred over STAR/SLASH) and
 * return its token start offset. The printer then breaks the line before
 * (or after, per `operatorPosition`) that single operator.
 *
 * Same SELECT-target width measurement as `computeMustWrapCases` /
 * `computeMustWrapWindows`. "Top-level" means: at the target's base paren
 * depth — operators inside parenthesized sub-expressions don't qualify.
 *
 * This is the residual long-line case: targets like
 *   `((a - b) * floor(...)) + ((c - d) * floor(...)) as alias`
 * which are too wide for one line but have no inner construct (CASE,
 * window, subquery) to wrap. Breaking at the outer `+` produces the
 * canonical two-line shape.
 */
function computeMustWrapWideExpressions(
	stream: NinjaSqlToken[],
	maxLineLength: number,
	policy: IndentPolicy,
): Set<number> {
	const out = new Set<number>();
	const indentWidth = policy.at(1).length || 4;

	let parenDepth = 0;
	let indentLevel = 0;
	const indentingParens: number[] = [];
	let prevSqlType = '';

	type OpEntry = { start: number; type: string };
	type Zone = {
		openedAtDepth: number;
		baseIndentLevel: number;
		curWidth: number;
		curTokenCount: number;
		// Top-level operator candidates within the current target.
		// `PLUS`/`MINUS` are lowest-precedence; `STAR`/`SLASH` are
		// fall-back. Indices store both type and start offset so the
		// flush can pick a low-precedence one if any exist.
		curArithmeticOps: OpEntry[];
		// Disqualifiers: targets containing a CASE, a wide-window-eligible
		// `over (`, or a subquery (`L_PAREN` immediately following SELECT)
		// are handled by their own dedicated must-wrap passes. Skip them
		// here to avoid double-wrapping.
		curHasCase: boolean;
		curHasWindow: boolean;
		curHasSubquery: boolean;
	};
	const zones: Zone[] = [];

	const flushTarget = (zone: Zone): void => {
		if (zone.curHasCase || zone.curHasWindow || zone.curHasSubquery) {
			// Reset and skip; other passes handle these shapes.
			zone.curWidth = 0;
			zone.curTokenCount = 0;
			zone.curArithmeticOps = [];
			zone.curHasCase = false;
			zone.curHasWindow = false;
			zone.curHasSubquery = false;
			return;
		}
		if (zone.curArithmeticOps.length === 0) {
			zone.curWidth = 0;
			zone.curTokenCount = 0;
			return;
		}
		const projected = (zone.baseIndentLevel + 1) * indentWidth
			+ zone.curWidth
			+ Math.max(0, zone.curTokenCount - 1);
		if (projected > maxLineLength) {
			// Prefer lowest precedence (`+`/`-`); fall back to `*`/`/`.
			const low = zone.curArithmeticOps.find(o => o.type === 'PLUS' || o.type === 'DASH' || o.type === 'MINUS');
			const pick = low ?? zone.curArithmeticOps[0];
			out.add(pick.start);
		}
		zone.curWidth = 0;
		zone.curTokenCount = 0;
		zone.curArithmeticOps = [];
	};

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category === 'jinja') {
			if (tok.tagEnd === undefined) continue;
			const litWidth = tok.tagEnd - tok.start;
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += litWidth;
				z.curTokenCount++;
			}
			continue;
		}
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			const isIndenting = isIndentingParenOpen(stream, i, prevSqlType);
			if (isIndenting) {
				indentLevel++;
				indentingParens.push(parenDepth);
			}
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += tok.end - tok.start + 1;
				z.curTokenCount++;
				if (prevSqlType === 'OVER') z.curHasWindow = true;
				// Indenting paren immediately after a comparison op / IN /
				// EXISTS means a scalar subquery is opening — let that pass
				// handle the wrap.
				if (isIndenting && prevSqlType !== 'ALIAS' && prevSqlType !== 'FROM' && prevSqlType !== 'JOIN') {
					z.curHasSubquery = true;
				}
			}
			prevSqlType = type;
			continue;
		}
		if (type === 'R_PAREN') {
			parenDepth = Math.max(0, parenDepth - 1);
			while (zones.length > 0 && zones[zones.length - 1].openedAtDepth > parenDepth) {
				flushTarget(zones[zones.length - 1]);
				zones.pop();
			}
			if (indentingParens.length > 0 && indentingParens[indentingParens.length - 1] === parenDepth + 1) {
				indentingParens.pop();
				indentLevel = Math.max(0, indentLevel - 1);
			}
			if (zones.length > 0) {
				const z = zones[zones.length - 1];
				z.curWidth += tok.end - tok.start + 1;
				z.curTokenCount++;
			}
			prevSqlType = type;
			continue;
		}

		if (type === 'SELECT') {
			zones.push({
				openedAtDepth: parenDepth,
				baseIndentLevel: indentLevel,
				curWidth: 0,
				curTokenCount: 0,
				curArithmeticOps: [],
				curHasCase: false,
				curHasWindow: false,
				curHasSubquery: false,
			});
			prevSqlType = type;
			continue;
		}

		if (zones.length > 0) {
			const z = zones[zones.length - 1];
			if (parenDepth === z.openedAtDepth) {
				if (type === 'COMMA') {
					flushTarget(z);
					prevSqlType = type;
					continue;
				}
				if (SELECT_LIST_END_KEYWORDS.has(type)) {
					flushTarget(z);
					zones.pop();
					prevSqlType = type;
					continue;
				}
				// Top-level arithmetic operator candidates land at the
				// target's base paren depth — operators nested inside
				// parens don't qualify (they're inside sub-expressions).
				if (type === 'PLUS' || type === 'DASH' || type === 'MINUS' || type === 'STAR' || type === 'SLASH') {
					// A `-` used as unary (start of target, or right after
					// another operator / `(` / comma) is not a binary
					// break point. Same for `+`. Guard with a simple
					// previous-token check.
					const prevIsOperand = prevSqlType !== '' && prevSqlType !== 'L_PAREN'
						&& prevSqlType !== 'COMMA' && prevSqlType !== 'SELECT'
						&& prevSqlType !== 'PLUS' && prevSqlType !== 'DASH'
						&& prevSqlType !== 'MINUS' && prevSqlType !== 'STAR'
						&& prevSqlType !== 'SLASH';
					if (prevIsOperand) {
						z.curArithmeticOps.push({ start: tok.start, type });
					}
				}
			}
			if (type === 'CASE') z.curHasCase = true;
			z.curWidth += tok.end - tok.start + 1;
			z.curTokenCount++;
		}

		prevSqlType = type;
	}

	while (zones.length > 0) {
		flushTarget(zones[zones.length - 1]);
		zones.pop();
	}

	return out;
}

/**
 * True when `enclosing` contains any class from `inner` AFTER the first
 * occurrence of `boundary`. Used to distinguish e.g. a comma that sits
 * directly under a `With` from one that sits under a `With > Paren > Func`
 * chain — the latter has `Paren` enclosing tighter than `With`, meaning
 * the comma belongs to the function call, not the CTE list.
 *
 * `enclosing` is ordered outermost → innermost (widest → tightest span).
 */
function hasInnerEnclosure(enclosing: string[], boundary: string, inner: string[]): boolean {
	const boundaryIdx = enclosing.indexOf(boundary);
	if (boundaryIdx === -1) return false;
	for (let i = boundaryIdx + 1; i < enclosing.length; i++) {
		if (inner.includes(enclosing[i])) return true;
	}
	return false;
}

/**
 * Clause keywords (uppercased) that terminate a SELECT target list at depth 0.
 * Includes set operators (UNION/INTERSECT/EXCEPT and their variants) because a
 * SELECT list also ends at the boundary of its branch — without this the
 * must-wrap range scan would walk past the set operator and pull tokens from
 * the next branch into the wrap range, which in turn mis-anchors the
 * trailing-comma injection point.
 */
const SELECT_LIST_END_KEYWORDS = new Set([
	'FROM', 'WHERE', 'GROUP_BY', 'GROUP', 'HAVING',
	'ORDER_BY', 'ORDER', 'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW', 'FETCH',
	'UNION', 'UNION_ALL', 'UNION_DISTINCT', 'INTERSECT', 'EXCEPT',
]);

/**
 * Comparison-operator token types. When a `(` appears immediately after one of
 * these AND the inside begins with `SELECT`, the parens enclose a scalar
 * subquery — `where x = (select max(...) from ...)` — and the body should
 * indent like any other subquery body. Plain `=`-followed-by-literal stays
 * inline because we gate on the next SQL token being `SELECT`.
 */
const COMPARISON_OPS = new Set(['EQ', 'NEQ', 'LT', 'LTE', 'GT', 'GTE']);

/**
 * Shared paren-indent classifier used by the helper passes (must-wrap CASE,
 * must-wrap window, must-wrap select). Mirrors the main walker's decision at
 * `printer.ts` line ~497 so the helpers' indent tracking matches the printer
 * exactly: ALIAS/FROM/JOIN/EXISTS always indent; IN/NOT_IN and comparison
 * operators indent only when followed by SELECT (subquery, not scalar list).
 * OVER-indented windows are handled by their own `mustWrapWindowParenStarts`
 * check inside the helpers that need it.
 */
function isIndentingParenOpen(
	stream: NinjaSqlToken[],
	openIdx: number,
	prevSqlType: string,
): boolean {
	if (prevSqlType === 'ALIAS' || prevSqlType === 'FROM' || prevSqlType === 'JOIN' || prevSqlType === 'EXISTS') {
		return true;
	}
	if (prevSqlType === 'IN' || prevSqlType === 'NOT_IN' || COMPARISON_OPS.has(prevSqlType)) {
		return peekNextSqlTokenTypeAt(stream, openIdx) === 'SELECT';
	}
	return false;
}

/**
 * Walk the sql-only token stream and return the byte range of every SELECT
 * target list that should be rendered one-target-per-line. Two triggers:
 *
 *   1. The list has multiple top-level targets (at least one comma at the
 *      SELECT's paren depth). Matches `layout.select-targets` / sqlfluff's
 *      LT09 prescription. Single-target SELECTs (`select foo from t`) stay
 *      inline.
 *   2. The single-line rendering would exceed `maxLineLength`. Covers the
 *      `layout.long-lines` case for single-target SELECTs where the one
 *      column expression is already too wide (in which case we still emit
 *      `select\n    <wide-expr>\nfrom ...` for readability).
 *
 * We work from the token stream (not AST `m` ranges) because sqlglot's serde
 * dump frequently omits position metadata on `Select` nodes, especially when
 * they sit inside CTE bodies — without this fallback the wrap heuristic
 * never fires for nested selects, which is the worst real-world bug.
 *
 * Width estimate per SELECT:
 *   indentColumn (depth-of-indenting-parens * indent unit width)
 *   + 'select' literal width
 *   + sum of target-token literal widths
 *   + one inter-token space per gap
 * Compared against `maxLineLength`. Conservative — counts a single space
 * between every token; the printer occasionally omits spaces (around
 * `.`, `(`, etc.), so a few borderline lines may wrap that would have
 * just fit. Acceptable vs. a two-pass simulation.
 */
function computeMustWrapSelects(
	stream: NinjaSqlToken[],
	maxLineLength: number,
	policy: IndentPolicy,
): Array<{ start: number; end: number; openedAtDepth: number }> {
	const ranges: Array<{ start: number; end: number; openedAtDepth: number }> = [];
	const indentWidth = policy.at(1).length || 4;

	// Track a synthetic indent level: every L_PAREN whose previous SQL token is
	// in INDENTING_PAREN_PREV bumps the level by 1; the matching R_PAREN
	// decrements. Function-call parens (preceded by an identifier) are NOT
	// indenting. We push the bump onto a stack tagged by paren depth so the
	// pop on R_PAREN only fires when the matching L_PAREN was indenting.
	let parenDepth = 0;
	let indentLevel = 0;
	const indentingParens: number[] = [];
	let prevSqlType = '';

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			// Indenting if prev token is ALIAS/FROM/JOIN/EXISTS, OR if it's
			// IN / NOT_IN / comparison-op followed by a SELECT (subquery, not
			// scalar list).
			const isIndenting = isIndentingParenOpen(stream, i, prevSqlType);
			if (isIndenting) {
				indentLevel++;
				indentingParens.push(parenDepth);
			}
			prevSqlType = type;
			continue;
		}
		if (type === 'R_PAREN') {
			if (indentingParens.length > 0 && indentingParens[indentingParens.length - 1] === parenDepth) {
				indentingParens.pop();
				indentLevel = Math.max(0, indentLevel - 1);
			}
			parenDepth = Math.max(0, parenDepth - 1);
			prevSqlType = type;
			continue;
		}

		if (type === 'SELECT') {
			// Scan forward through the target list, stopping at a depth-0
			// clause keyword. Track tokens that belong to the projected
			// single line: SELECT itself plus everything up to (but not
			// including) the clause keyword.
			let depth = 0;
			let widthChars = tok.end - tok.start + 1; // 'select'
			let tokenCount = 1;
			let lastEnd = tok.end;
			let topLevelCommas = 0;
			let j = i + 1;
			for (; j < stream.length; j++) {
				const t = stream[j];
				if (t.category !== 'sql') continue;
				const tt = t.type.toUpperCase();
				if (tt === 'L_PAREN') { depth++; }
				else if (tt === 'R_PAREN') {
					if (depth === 0) break; // unmatched close — bail
					depth--;
				}
				if (depth === 0 && SELECT_LIST_END_KEYWORDS.has(tt)) break;
				if (depth === 0 && tt === 'COMMA') topLevelCommas++;
				widthChars += t.end - t.start + 1;
				tokenCount++;
				lastEnd = t.end;
			}
			// One space between adjacent tokens.
			const projected = indentLevel * indentWidth + widthChars + Math.max(0, tokenCount - 1);
			// Wrap when either (a) there are multiple top-level targets —
			// LT09 / layout.select-targets prescription — or (b) the single-
			// line rendering would exceed maxLineLength.
			if (topLevelCommas >= 1 || projected > maxLineLength) {
				ranges.push({ start: tok.start, end: lastEnd, openedAtDepth: parenDepth });
			}
			prevSqlType = type;
			continue;
		}

		prevSqlType = type;
	}

	return ranges;
}

function peekNextSqlTokenTypeAt(stream: NinjaSqlToken[], start: number): string | undefined {
	for (let i = start + 1; i < stream.length; i++) {
		if (stream[i].category === 'sql') return stream[i].type.toUpperCase();
	}
	return undefined;
}

/**
 * Token-stream fallback that classifies every comma which separates targets
 * of a SELECT at depth 0 (i.e. not inside a function call, IN list, or
 * nested subquery's own SELECT). Returns a set of comma `start` offsets.
 *
 * Used by the printer when the AST has no position metadata on `Select`
 * nodes (sqlglot's serde drops `m` on inner Selects under CTE bodies for
 * some dialects), which would otherwise leave nested SELECT-list commas
 * unrecognized — defeating the must-wrap path.
 *
 * Scanning rules:
 *   - Each SELECT opens a target-list "zone" at the current paren depth.
 *   - Every depth-0 comma inside the zone is a select-list comma.
 *   - The zone closes at the first depth-0 clause keyword (FROM/WHERE/etc).
 *   - A nested SELECT inside parens opens a *new* zone at its own depth;
 *     the outer zone resumes once the parens close.
 */
function computeSelectListCommas(stream: NinjaSqlToken[]): Set<number> {
	const out = new Set<number>();
	// Stack of active SELECT zones: { parenDepth: depth at which this SELECT
	// was opened }. The top of the stack is the innermost active zone; depth-0
	// commas relative to that zone's paren depth are its target separators.
	const zones: Array<{ openedAtDepth: number }> = [];
	let parenDepth = 0;

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			continue;
		}
		if (type === 'R_PAREN') {
			// Closing a paren may close any zones opened deeper than the new depth.
			parenDepth = Math.max(0, parenDepth - 1);
			while (zones.length > 0 && zones[zones.length - 1].openedAtDepth > parenDepth) {
				zones.pop();
			}
			continue;
		}

		if (type === 'SELECT') {
			zones.push({ openedAtDepth: parenDepth });
			continue;
		}

		// Comma at the active zone's depth => select-list separator.
		if (type === 'COMMA' && zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth === top.openedAtDepth) {
				out.add(tok.start);
			}
			continue;
		}

		// Clause keyword at the active zone's depth closes that zone.
		if (zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth === top.openedAtDepth && SELECT_LIST_END_KEYWORDS.has(type)) {
				zones.pop();
			}
		}
	}

	return out;
}

/**
 * Token-stream fallback that locates AND/OR tokens which need a forced line
 * break to satisfy `convention.operator-position`. Returns a set of token
 * `start` offsets.
 *
 * The printer's AST path (`enclosing.includes('Where' | 'Having' | 'Join')`)
 * fails when sqlglot's serde dump drops position metadata on those nodes —
 * common for inner statements. Without a fallback the source layout sticks,
 * even when it violates the configured operator position.
 *
 * We intentionally restrict the fallback to operators whose SOURCE position
 * already crosses a line boundary (the AND/OR sits on a different line than
 * either its previous or its next SQL token). Single-line predicate chains
 * — `where a = 1 and b = 2` — are not flagged: they neither violate the
 * leading-position rule nor the trailing-position rule, so the printer
 * leaves them inline. This matches the existing behaviour for AST-detected
 * predicate booleans on single-line WHEREs and avoids regressing
 * kitchen-sink-style fixtures that expect the inline form.
 *
 * Scanning rules:
 *   - A WHERE / HAVING keyword at depth 0 opens a predicate zone at the
 *     current paren depth. The zone closes at the next depth-0 clause
 *     keyword that ends the predicate, or at the matching close-paren.
 *   - AND/OR at the zone's depth is a candidate predicate boolean.
 *   - CASE / IF opens an inner zone that suppresses the classification
 *     until the matching END.
 *   - A candidate is added only when its source line differs from either
 *     the previous OR the next SQL token's line.
 */
function computePredicateBooleans(stream: NinjaSqlToken[]): Set<number> {
	const out = new Set<number>();
	const zones: Array<{ openedAtDepth: number }> = [];
	let caseDepth = 0;
	let parenDepth = 0;
	// SQL tokens (typed) walked alongside the unified stream so we can find
	// the prev/next SQL token of each candidate without re-filtering.
	const sqlIdx: number[] = [];
	for (let i = 0; i < stream.length; i++) {
		if (stream[i].category === 'sql') sqlIdx.push(i);
	}
	// Map from full-stream index → position in sqlIdx for fast prev/next lookup.
	const sqlPos = new Map<number, number>();
	for (let k = 0; k < sqlIdx.length; k++) sqlPos.set(sqlIdx[k], k);

	const ZONE_END = new Set([
		'FROM', 'WHERE', 'GROUP_BY', 'GROUP', 'HAVING', 'ORDER_BY', 'ORDER',
		'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW', 'FETCH',
		'UNION', 'UNION_ALL', 'UNION_DISTINCT', 'INTERSECT', 'EXCEPT',
		'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
	]);

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') { parenDepth++; continue; }
		if (type === 'R_PAREN') {
			parenDepth = Math.max(0, parenDepth - 1);
			while (zones.length > 0 && zones[zones.length - 1].openedAtDepth > parenDepth) {
				zones.pop();
			}
			continue;
		}

		if (type === 'CASE' || type === 'IF') { caseDepth++; continue; }
		if (type === 'END' && caseDepth > 0) { caseDepth--; continue; }

		if (type === 'WHERE' || type === 'HAVING') {
			zones.push({ openedAtDepth: parenDepth });
			continue;
		}

		if (zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth === top.openedAtDepth && ZONE_END.has(type)) {
				zones.pop();
			}
		}

		if ((type === 'AND' || type === 'OR') && caseDepth === 0 && zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth !== top.openedAtDepth) continue;

			// Only flag when the SOURCE already spans a line boundary around
			// this AND/OR — i.e. the inputs is multi-line in a way that the
			// printer is reflowing. Pure single-line predicate chains stay
			// inline (matches AST-path behaviour for single-line WHEREs).
			const k = sqlPos.get(i)!;
			const prevSql = k > 0 ? stream[sqlIdx[k - 1]] : undefined;
			const nextSql = k < sqlIdx.length - 1 ? stream[sqlIdx[k + 1]] : undefined;
			const crossesLineBefore = prevSql && prevSql.line !== tok.line;
			const crossesLineAfter = nextSql && nextSql.line !== tok.line;
			if (crossesLineBefore || crossesLineAfter) {
				out.add(tok.start);
			}
		}
	}

	return out;
}

/**
 * Token-stream fallback that locates every JOIN-ON / JOIN-USING region whose
 * predicate chain contains at least one AND/OR. Returns byte ranges spanning
 * from the `ON` (or `USING`) token's `start` to the start of the token that
 * terminates the predicate chain (exclusive boundary, captured as
 * `end = chain-end-token.start - 1` so `inAnyRange` works).
 *
 * Why this exists: sqlglot's serde leaves `Join.m` empty in real parser
 * output, so the AST path
 * (`findEnclosing(... 'Join')` + `containsAny(... 'And'|'Or')`) returns
 * false even when the source clearly has multi-predicate ONs. Without this
 * fallback, `indented_on` collapses to a single mega-line:
 *   `inner join u as so on a.x = b.x and a.y = b.y and a.z = b.z`
 *
 * Scanning rules (paren-depth aware):
 *   - A JOIN-cluster start (`JOIN`/`LEFT`/`RIGHT`/`INNER`/`OUTER`/`FULL`/
 *     `CROSS`) at the current `parenDepth` enters "scanning join" state.
 *   - The first `ON` or `USING` at the join's paren depth opens the
 *     predicate chain.
 *   - Inside the chain, any AND/OR at the same paren depth flips the
 *     "has predicate operator" flag.
 *   - The chain closes at the next JOIN-cluster start, the next
 *     MAJOR_CLAUSES keyword, or when paren depth drops below the join's
 *     depth (end of enclosing query / function). End of stream also
 *     closes.
 *   - If the chain had AND/OR, the range from the ON-token's start to the
 *     terminator's prev-token end is emitted.
 *
 * The chain end byte is set to `terminator.start - 1` so an AND/OR token
 * sitting AT the chain terminator wouldn't accidentally fall inside.
 * (Won't happen in practice — terminators are JOIN/MAJOR keywords —
 * but the boundary stays clean either way.)
 */
function computeMultiPredicateJoinOnRanges(stream: NinjaSqlToken[]): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	let parenDepth = 0;
	let prevTypeUpper = '';
	// Active join chain state. null when not inside a JOIN-ON/USING chain.
	let chain: { joinDepth: number; onStart: number; hasAndOr: boolean; lastTokEnd: number } | null = null;
	// `scanningJoin` is true after a JOIN-cluster start has been seen at
	// `joinDepth` but before its ON/USING. We use it to bind the ON to the
	// most recent JOIN cluster rather than to any random ON in source order.
	let scanningJoin: { joinDepth: number } | null = null;

	const closeChain = (): void => {
		if (chain && chain.hasAndOr) {
			// `lastTokEnd` was the end byte of the last token in the chain;
			// the terminator is the current token. The range covers the ON
			// keyword's start to the byte just before the terminator.
			ranges.push({ start: chain.onStart, end: chain.lastTokEnd });
		}
		chain = null;
	};

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			prevTypeUpper = type;
			continue;
		}
		if (type === 'R_PAREN') {
			parenDepth = Math.max(0, parenDepth - 1);
			// If the closing paren drops us below the active chain's depth,
			// the chain is done.
			if (chain && parenDepth < chain.joinDepth) closeChain();
			if (scanningJoin && parenDepth < scanningJoin.joinDepth) scanningJoin = null;
			prevTypeUpper = type;
			continue;
		}

		// JOIN-cluster start at paren depth 0 (or the join's depth) terminates
		// any active chain and opens a new scanning state.
		if (JOIN_START.has(type) && !JOIN_CONTINUATION_PREV.has(prevTypeUpper)) {
			if (chain && parenDepth === chain.joinDepth) closeChain();
			scanningJoin = { joinDepth: parenDepth };
			prevTypeUpper = type;
			continue;
		}

		// MAJOR_CLAUSES at the active chain's paren depth closes the chain.
		if (chain && parenDepth === chain.joinDepth && MAJOR_CLAUSES.has(type)) {
			closeChain();
			scanningJoin = null;
			prevTypeUpper = type;
			continue;
		}

		// ON / USING after a JOIN-cluster start opens the predicate chain.
		if ((type === 'ON' || type === 'USING')
			&& scanningJoin
			&& parenDepth === scanningJoin.joinDepth
		) {
			// Close any previously open chain (shouldn't happen normally
			// since JOIN_START already closed it, but defensive).
			if (chain) closeChain();
			chain = {
				joinDepth: parenDepth,
				onStart: tok.start,
				hasAndOr: false,
				lastTokEnd: tok.end,
			};
			scanningJoin = null;
			prevTypeUpper = type;
			continue;
		}

		// Inside an open chain, track AND/OR at the chain's depth.
		if (chain) {
			if ((type === 'AND' || type === 'OR') && parenDepth === chain.joinDepth) {
				chain.hasAndOr = true;
			}
			chain.lastTokEnd = tok.end;
		}

		prevTypeUpper = type;
	}

	// End of stream closes any open chain.
	if (chain) closeChain();

	return ranges;
}

/** True when `offset` falls inside any of the provided byte ranges. */
function inAnyRange(offset: number, ranges: Array<{ start: number; end: number }>): boolean {
	for (const r of ranges) {
		if (offset >= r.start && offset <= r.end) return true;
	}
	return false;
}

/**
 * True when the previous token (at byte `offset`, paren depth `parenDepth`)
 * is the last token of a wrapped SELECT-list target — used by the
 * trailing-comma injection to anchor the comma after the final target.
 *
 * The match requires the offset to fall inside the SELECT's wrap range AND
 * the current paren depth to equal the SELECT's own depth. The depth check
 * prevents false positives from clause keywords inside nested indenting
 * parens — e.g. `order by` inside an `over (partition by ... order by ...)`
 * window would otherwise be mistaken for the outer SELECT's terminator.
 */
function isSelectListBoundary(
	offset: number,
	parenDepth: number,
	ranges: Array<{ start: number; end: number; openedAtDepth: number }>,
): boolean {
	for (const r of ranges) {
		if (offset >= r.start && offset <= r.end && parenDepth === r.openedAtDepth) return true;
	}
	return false;
}

/**
 * Peek forward in the token stream past `start` and return the uppercase
 * `type` of the next SQL token (skipping any jinja tokens). Used to look
 * inside a paren and decide whether it opens a subquery (`(SELECT ...)`)
 * or a non-indenting list (`('a', 'b', ...)`) — only the former should
 * trigger a body indent.
 */
function peekNextSqlTokenType(stream: NinjaSqlToken[], start: number): string | undefined {
	for (let i = start + 1; i < stream.length; i++) {
		if (stream[i].category === 'sql') return stream[i].type.toUpperCase();
	}
	return undefined;
}

/**
 * Like {@link peekNextSqlTokenType} but returns the full token (so the caller
 * can inspect attached comments, position, etc.). The return type is narrowed
 * to the sql-category branch of the {@link NinjaSqlToken} union, so callers
 * have direct access to {@link SqlToken} fields like `comments`.
 */
function peekNextSqlToken(stream: NinjaSqlToken[], start: number): ({ category: 'sql' } & SqlToken) | undefined {
	for (let i = start + 1; i < stream.length; i++) {
		const t = stream[i];
		if (t.category === 'sql') return t;
	}
	return undefined;
}

/**
 * Like {@link hasInnerEnclosure} but tests a set of possible boundary
 * classes. Returns true when *any* of them has a deeper `inner` class in
 * the ancestry chain. Used for "is this boolean inside a predicate clause
 * but also inside a nested Case/If expression?" — breaking there would
 * scramble CASE readability.
 */
function hasInnerEnclosureAny(enclosing: string[], boundaries: string[], inner: string[]): boolean {
	let firstBoundaryIdx = -1;
	for (let i = 0; i < enclosing.length; i++) {
		if (boundaries.includes(enclosing[i])) {
			firstBoundaryIdx = i;
			break;
		}
	}
	if (firstBoundaryIdx === -1) return false;
	for (let i = firstBoundaryIdx + 1; i < enclosing.length; i++) {
		if (inner.includes(enclosing[i])) return true;
	}
	return false;
}
