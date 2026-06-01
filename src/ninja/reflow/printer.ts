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
const JOIN_START = new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL']);
/**
 * When the previous token is itself a JOIN modifier, the current JOIN-start
 * token is a continuation of the same JOIN cluster (e.g. `LEFT JOIN`,
 * `FULL OUTER JOIN`) and must not trigger a second newline.
 */
const JOIN_CONTINUATION_PREV = new Set(['JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL']);

const SET_OPERATOR = new Set(['UNION', 'INTERSECT', 'EXCEPT']);

/**
 * Token types whose text must not take a space on its left. These sit
 * flush against the preceding token — e.g. the `(` in a function call, the
 * `.` in `schema.table`, the comma (space handling is policy-driven).
 */
const NO_SPACE_BEFORE = new Set(['COMMA', 'R_PAREN', 'R_BRACKET', 'DOT', 'SEMICOLON', 'DCOLON']);

/**
 * SQL builtins that sqlglot tokenises as keyword-typed tokens (not VAR /
 * IDENTIFIER) but which still function syntactically as function calls.
 * The dialect-symbol path catches most builtins, but these ones are
 * absent from common dialect function sets (DuckDB, Snowflake) so we
 * pin them here. Match against the token's UPPERCASED type.
 */
const KEYWORD_FUNCTION_TOKENS = new Set([
	'ISNULL',
	'IIF',
	'IF',
	'CAST', // some dialects emit CAST as a keyword
	'EXTRACT',
	'POSITION',
	'SUBSTRING',
	'TRIM',
	'OVERLAY',
	'CONVERT',
]);

/**
 * Prev-token types that are categorically NOT a function name. Used as a
 * deny-list when checking whether `(` is a function-call paren — dialect
 * function sets can wrongly contain operator words like `and` / `or` /
 * `not`, so we hard-exclude them by token type before consulting the
 * function set.
 */
const NOT_FUNCTION_PREV_TYPES = new Set([
	'AND', 'OR', 'NOT', 'IN', 'NOT_IN', 'IS', 'BETWEEN', 'LIKE', 'ILIKE', 'GLOB', 'SIMILAR_TO',
	'EXISTS', 'WHEN', 'THEN', 'ELSE', 'END', 'ON', 'USING', 'CASE', 'AS', 'ALIAS',
	'WHERE', 'HAVING', 'GROUP_BY', 'GROUP', 'ORDER_BY', 'ORDER', 'BY', 'FROM',
	'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL',
	'UNION', 'UNION_ALL', 'UNION_DISTINCT', 'INTERSECT', 'EXCEPT',
	'WITH', 'SELECT', 'DISTINCT', 'ALL', 'TOP', 'LIMIT', 'OFFSET', 'QUALIFY', 'FETCH', 'WINDOW',
	'L_PAREN', 'R_PAREN', 'L_BRACKET', 'R_BRACKET', 'COMMA', 'SEMICOLON', 'DOT', 'DCOLON',
	'EQ', 'NEQ', 'LT', 'GT', 'LTE', 'GTE', 'PLUS', 'DASH', 'STAR', 'SLASH', 'PERCENT', 'CARET',
	'PIPE', 'DPIPE', 'AMP', 'TILDA', 'COLON', 'COLON_EQ', 'ARROW', 'DARROW', 'FARROW',
	'INTERVAL', 'PARTITION_BY', 'PARTITION', 'OVER', 'INTO', 'VALUES', 'SET', 'UPDATE', 'INSERT', 'DELETE',
]);

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
	const mustWrapSelectRanges = computeMustWrapSelects(
		stream, config.maxLineLength, policy, config.layout.alwaysWrap.select);
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
	const {
		ranges: multiPredicateJoinOnRanges,
		breakOffsets: multiPredicateJoinOnBreakOffsets,
	} = computeMultiPredicateJoinOnRanges(stream);
	// General-case logical predicate paren detection (applies in WHERE,
	// HAVING, JOIN ON, CASE WHEN, anywhere `(` contains an AND/OR chain).
	// Subsumes the JOIN-ON-specific wrapParens handling — any paren with
	// logical content that's source-multi-line or width-overflowing opens
	// as an indenting body.
	const { parenStarts: logicalPredicateParens, breakOffsets: logicalPredicateBreakOffsets }
		= computeLogicalPredicateParens(stream, config.maxLineLength);
	for (const off of logicalPredicateBreakOffsets) predicateBooleanOffsets.add(off);
	// Pre-pass: locate CASE...END spans whose single-line projected width would
	// exceed `maxLineLength`. The set of CASE token start offsets identifies
	// the entries — during the walk we push CASE state on a stack at each
	// matching CASE and emit per-WHEN / per-ELSE / per-END breaks, restoring
	// indent at END.
	const mustWrapCaseStarts = computeMustWrapCases(
		stream, config.maxLineLength, policy, config.layout.alwaysWrap.case);
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
	const mustWrapWindowParenStarts = computeMustWrapWindows(
		stream, config.maxLineLength, policy,
		config.layout.alwaysWrap.windowPartitionBy,
		config.layout.alwaysWrap.windowOrderBy,
	);
	// Pre-pass: locate top-level arithmetic operators inside SELECT targets
	// whose single-line projection would exceed `maxLineLength` and that
	// have no CASE/window/scalar-subquery (those have their own dedicated
	// wraps). Set of operator-token start offsets. When the walker emits
	// the operator, it breaks before (leading) or after (trailing) it.
	const mustWrapWideExprOps = computeMustWrapWideExpressions(stream, config.maxLineLength, policy);
	// THEN offsets whose preceding WHEN's body spans multiple lines (via
	// predicate-boolean or arithmetic wraps) — those THENs need their own
	// indented line. Computed after both wrap sets are known.
	const multiLineWhenThens = computeMultiLineWhenThens(
		stream, predicateBooleanOffsets, mustWrapWideExprOps);
	// Pre-pass: GROUP BY / ORDER BY clause ranges that must wrap. Width-
	// driven by default; `alwaysWrap.{groupBy,orderBy}` adds the second
	// trigger. The matching comma-offset sets identify which commas inside
	// the stream belong to those clauses, so the main walk can route
	// list-clause commas through the same wrap path as SELECT-list commas.
	const mustWrapGroupByRanges = computeMustWrapListClauses(
		stream, config.maxLineLength, policy, new Set(['GROUP_BY']), config.layout.alwaysWrap.groupBy);
	const mustWrapOrderByRanges = computeMustWrapListClauses(
		stream, config.maxLineLength, policy, new Set(['ORDER_BY']), config.layout.alwaysWrap.orderBy);
	const groupByListCommaOffsets = computeListClauseCommas(stream, new Set(['GROUP_BY']));
	const orderByListCommaOffsets = computeListClauseCommas(stream, new Set(['ORDER_BY']));
	// Pre-pass: WHERE / HAVING token offsets that should emit a newline
	// AFTER the keyword (pushing the first predicate to its own indented
	// line). Fires only when the toggle is on AND the clause has 2+
	// predicates joined by AND/OR. Subsequent predicate breaks are still
	// handled by the operator-position machinery.
	const whereAlwaysWrap = computeAlwaysWrapPredicateClauses(
		stream, 'WHERE', config.layout.alwaysWrap.where);
	const havingAlwaysWrap = computeAlwaysWrapPredicateClauses(
		stream, 'HAVING', config.layout.alwaysWrap.having);
	const alwaysWrapWhereStarts = whereAlwaysWrap.keywordStarts;
	const alwaysWrapHavingStarts = havingAlwaysWrap.keywordStarts;

	// Pre-pass: build an offset → line-number index so we can cheaply find
	// which line a comment's `start` sits on. Used by the source-blank-line
	// detection below (comments don't carry `line` directly — only SQL
	// tokens do — so we derive it from the source character stream).
	const lineForOffset = new Int32Array(source.length + 1);
	{
		let l = 0;
		for (let i = 0; i < source.length; i++) {
			lineForOffset[i] = l;
			if (source.charCodeAt(i) === 10 /* '\n' */) l++;
		}
		lineForOffset[source.length] = l;
	}
	const lineOfOffset = (offset: number): number => {
		if (offset < 0) return 0;
		if (offset >= lineForOffset.length) return lineForOffset[lineForOffset.length - 1];
		return lineForOffset[offset];
	};
	// Merge the always-wrap-forced AND/OR offsets into the predicate-boolean
	// set so the existing operator-position wrap path picks them up. Without
	// this merge, the toggle would only break the keyword line — every
	// AND/OR after the first predicate would stay inline.
	for (const off of whereAlwaysWrap.forcedBooleans) predicateBooleanOffsets.add(off);
	for (const off of havingAlwaysWrap.forcedBooleans) predicateBooleanOffsets.add(off);

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
	// Parallel stack: true when the indenting paren follows `on` in a
	// multi-predicate JOIN. Used for two things at the matching close:
	// (1) `)` lands at the column of `on (` instead of the outer base —
	// mirrors the wide-window restore. (2) AND/OR breaks inside skip the
	// continuation +1 indent so predicates and operators share an indent.
	const indentingParenIsOn: boolean[] = [];
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
	// One-shot extra indent used for `indented_on` / `indented_then` /
	// `indented_joins`: consumed by the next `emitNewline()` and then
	// reset to 0, so only the single line introduced by the trigger
	// token receives the deeper indent.
	let oneShotExtraIndent = 0;
	// Queued counterpart of `currentLineIsBooleanContinuation`: set when an
	// AND/OR predicate-boolean break is queued. emitNewline consumes it onto
	// `currentLineIsBooleanContinuation` so the next line knows it's a wrap
	// of a boolean chain (and therefore an inner arithmetic break should
	// indent +1 deeper than the AND, not align with it).
	let oneShotIsBooleanContinuation = false;
	// True when the current line was started by a predicate-boolean (AND/OR)
	// continuation break. Used by the arithmetic-break path to decide
	// whether to indent the continuation flat (target wrap — same column)
	// or one deeper (wrap-of-wrap inside an AND chain).
	let currentLineIsBooleanContinuation = false;

	// Stack tracking whether each currently-open SELECT was force-wrapped
	// onto multiple lines. When FROM follows a non-wrapped SELECT it stays
	// inline (`select * from t`); otherwise it goes on its own line. The
	// stack handles nested SELECTs — inner subqueries push their own
	// state, FROM pops it, so the outer SELECT's state isn't clobbered.
	const selectWrappedStack: boolean[] = [];

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
		// Idempotent at line start: a redundant call (e.g. leading comments
		// already broke us onto a fresh line and the downstream predicate-
		// boolean handler then queues another break) must NOT insert a blank
		// line. Only `pendingBlankLine` is allowed to push a second `\n`.
		// If `oneShotExtraIndent` changed since the previous emit, retroactively
		// fix the indent on the current line by replacing the last indent
		// entry — keeps continuation indents aligned without doubling newlines.
		if (atLineStart && !pendingBlankLine) {
			if (oneShotExtraIndent !== currentLineExtraIndent) {
				parts[parts.length - 1] = policy.at(indentLevel + oneShotExtraIndent);
				currentLineExtraIndent = oneShotExtraIndent;
			}
			currentLineIsBooleanContinuation = oneShotIsBooleanContinuation;
			oneShotExtraIndent = 0;
			oneShotIsBooleanContinuation = false;
			return;
		}
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
		currentLineIsBooleanContinuation = oneShotIsBooleanContinuation;
		oneShotExtraIndent = 0;
		oneShotIsBooleanContinuation = false;
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

		// ── Source blank-line preservation ────────────────────────────────
		// If the source had a blank line between the previous token (SQL or
		// Jinja) and this token's first emission (leading comment OR the
		// token itself), queue a blank line. Skipped inside indenting
		// parens / function calls — blank lines in those contexts are
		// almost always source formatting noise rather than meaningful
		// section separators.
		//
		// We derive the prev line from the source offset (not `prev.line`)
		// so the check works for both SQL and Jinja tokens — Jinja tokens
		// don't carry the same `line` field.
		if (prev && config.maxBlankLines > 0 && parenDepth === 0) {
			const prevLine = lineOfOffset(prev.end);
			let firstEmitLine = tok.line;
			if (tok.comments?.length) {
				for (const c of tok.comments) {
					if (c.start < tok.start) {
						const cLine = lineOfOffset(c.start);
						if (cLine < firstEmitLine) firstEmitLine = cLine;
					}
				}
			}
			if (firstEmitLine - prevLine > 1) {
				pendingBlankLine = true;
			}
		}

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

		// EOL comment reclassification: sqlglot may attribute a comment that
		// was originally at end-of-line of the previous token to this token
		// as a leading comment. Detect that (the comment's source line
		// matches `prev.line`) and place it inline AFTER the previous
		// token's literal — preserving the source's EOL placement instead
		// of demoting the comment to its own line below the code.
		//
		// When the inline placement would push the line past
		// `maxLineLength`, promote the comment to a leading line ABOVE the
		// previous token's line (matching the prev line's indent). Never
		// demote below — comments lead code, not trail it.
		//
		// `partsLengthAtIterStart` is the splice point: the end of `parts`
		// at this iteration's start, which is just past the previous
		// token's trailing emissions. Captured before any leading-drain
		// emission so the splice lands in the right place.
		const partsLengthAtIterStart = parts.length;
		const handledEolCommentStarts = new Set<number>();
		if (tok.comments?.length && !skipNextTokenLeadingComments && !isPotentialPredicateBoolHoist
			&& prev && prev.category === 'sql'
		) {
			for (const c of tok.comments) {
				if (c.start >= tok.start) continue;
				const cLine = lineOfOffset(c.start);
				if (cLine !== prev.line) continue;
				const raw = source.slice(c.start, c.end);
				const isLineComment = raw.startsWith('--') || raw.startsWith('//');
				// Inline candidate. Measure projected line length first.
				const lineStart = (() => {
					for (let i = partsLengthAtIterStart - 1; i >= 0; i--) {
						if (parts[i] === '\n') return i + 1;
					}
					return 0;
				})();
				let lineLen = ' '.length + raw.length;
				for (let i = lineStart; i < partsLengthAtIterStart; i++) lineLen += parts[i].length;
				if (lineLen <= config.maxLineLength) {
					parts.splice(partsLengthAtIterStart, 0, ' ' + raw);
				} else {
					// Promote to leading-above prev's line. Splice
					// `<indent><comment>\n` right at the start of prev's
					// line so the comment leads (without removing prev).
					const indentEntry = parts[lineStart] ?? '';
					parts.splice(lineStart, 0, indentEntry, raw, '\n');
				}
				handledEolCommentStarts.add(c.start);
				if (isLineComment) pendingNewline = true;
			}
		}

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
			// AST-driven predicate-boolean detection: AND/OR whose nearest
			// enclosing predicate scope is WHERE/HAVING/JOIN, with no
			// CASE/IF/Paren shadowing in between. Paren is in the inner-
			// exclusion list so an AND/OR inside a parenthesized sub-
			// predicate (`(a and b)` as one of several OR'd groups) stays
			// inline — only the TOP-level OR between the groups breaks.
			const willBePredicateBool = (typeUpper === 'AND' || typeUpper === 'OR')
				&& (
					(
						(enclosing.includes('Where') || enclosing.includes('Having') || enclosing.includes('Join'))
						&& !hasInnerEnclosureAny(enclosing, ['Where', 'Having', 'Join'], ['Case', 'If', 'Paren'])
					)
					|| predicateBooleanOffsets.has(tok.start)
					|| multiPredicateJoinOnBreakOffsets.has(tok.start)
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
					&& (enclosing.includes('Case') || enclosing.includes('If')
						|| multiLineWhenThens.has(tok.start))
					&& policy.indentedThen);
			const carriedExtraIndent = oneShotExtraIndent || (willTriggerContinuationIndent ? 1 : 0);
			for (const c of tok.comments) {
				if (c.start < tok.start && !handledEolCommentStarts.has(c.start)) {
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
		// GROUP BY / ORDER BY list-separator commas — same wrap mechanics as
		// SELECT-list commas. Detection is token-stream-only since the AST
		// path's `Group`/`Order` enclosure check would only confirm we're in
		// the right clause; the comma-zone tracker is sufficient.
		const isGroupByListComma = typeUpper === 'COMMA'
			&& groupByListCommaOffsets.has(tok.start);
		const isOrderByListComma = typeUpper === 'COMMA'
			&& orderByListCommaOffsets.has(tok.start);
		const isListClauseComma = isSelectListComma || isGroupByListComma || isOrderByListComma;
		// Each comma checks only its OWN clause's wrap ranges. Without this
		// scoping, an inner ORDER BY comma inside a wide outer SELECT would
		// be misclassified as wrappable because the SELECT range encloses
		// the entire window paren.
		const inListClauseWrapRange = isListClauseComma
			&& (
				(isSelectListComma && inAnyRange(tok.start, mustWrapSelectRanges))
				|| (isGroupByListComma && inAnyRange(tok.start, mustWrapGroupByRanges))
				|| (isOrderByListComma && inAnyRange(tok.start, mustWrapOrderByRanges))
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
				|| (prevTypeUpper === 'OVER' && mustWrapWindowParenStarts.has(tok.start))
				// Any `(` that wraps a logical (AND/OR) predicate group — in
				// WHERE, HAVING, JOIN ON, CASE WHEN, or anywhere else —
				// opens as an indenting body when the body is source-multi-
				// line or width-overflowing. Subsumes the older JOIN-ON-
				// specific wrap-paren handling.
				|| logicalPredicateParens.has(tok.start));
		void innermost;
		// An R_PAREN that closes the top indenting span needs a newline
		// BEFORE it so the close sits alone on its own de-indented line.
		const parenClosesIndent = typeUpper === 'R_PAREN'
			&& indentingParens.length > 0
			&& indentingParens[indentingParens.length - 1] === parenDepth;
		// An L_PAREN that follows an identifier is a function-call paren
		// and must hug the identifier (no space). Four detection paths:
		//   1. Prev SQL token type is VAR / IDENTIFIER (generic name).
		//   2. AST classifies the paren's innermost enclosing node as
		//      Func or Anonymous.
		//   3. Prev token's literal matches the active dialect's function
		//      name set (catches `coalesce`, `nullif`, `cast`, etc.).
		//   4. Prev token's TYPE is a known keyword-builtin that sqlglot
		//      tokenizes specially (`ISNULL`, `IIF`, `IF`, etc.) — these
		//      function syntactically as function calls regardless of
		//      what sqlglot's AST classifies them as.
		const prevLiteralLower = prev && prev.category === 'sql'
			? source.slice(prev.start, prev.end + 1).toLowerCase()
			: '';
		const functionCallParen = typeUpper === 'L_PAREN'
			&& !NOT_FUNCTION_PREV_TYPES.has(prevTypeUpper)
			&& (prevTypeUpper === 'VAR' || prevTypeUpper === 'IDENTIFIER'
				|| innermost === 'Func' || innermost === 'Anonymous'
				|| (symbols?.functions.has(prevLiteralLower) ?? false)
				|| KEYWORD_FUNCTION_TOKENS.has(prevTypeUpper));
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
		// indented_then policy. Token-stream fallback (multiLineWhenThens)
		// covers cases where sqlglot's AST didn't propagate Case/If
		// metadata to the THEN token's position.
		const isIndentedThen = typeUpper === 'THEN'
			&& (enclosing.includes('Case') || enclosing.includes('If')
				|| multiLineWhenThens.has(tok.start))
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
					&& !hasInnerEnclosureAny(enclosing, ['Where', 'Having', 'Join'], ['Case', 'If', 'Paren'])
			) || predicateBooleanOffsets.has(tok.start)
				|| multiPredicateJoinOnBreakOffsets.has(tok.start)
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
				// (Previous versions also injected a trailing comma here after
				// the last SELECT target — that behavior matched neither sqlfmt
				// nor the current dbt-labs style guide, both of which leave the
				// final target without a comma. The injection has been removed;
				// trailing commas now exist only BETWEEN targets.)
				// Clear any one-shot indent the last target-comma queued —
				// FROM/WHERE/etc land at the clause's base indent, not the
				// target-continuation indent.
				oneShotExtraIndent = 0;
				// FROM stays inline with the preceding SELECT when that SELECT
				// didn't wrap (single short target fit on one line). Avoids
				// the unconditional `select <x>\nfrom <y>` split for trivial
				// queries like `select * from t`. All other major clauses
				// (WHERE, GROUP BY, ORDER BY, etc.) always break.
				let inlineWithSelect = false;
				if (typeUpper === 'FROM' && selectWrappedStack.length > 0) {
					const wrapped = selectWrappedStack.pop()!;
					inlineWithSelect = !wrapped;
				}
				if (!inlineWithSelect) {
					pendingNewline = true;
				}
				if (typeUpper === 'SELECT') {
					selectWrappedStack.push(inAnyRange(tok.start, mustWrapSelectRanges));
				}
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
			// indented_then: THEN lands one level deeper than WHEN — same
			// rule sqlfluff uses. THEN is treated as a continuation of the
			// WHEN branch (the value follows from the condition), so it
			// indents like any other continuation.
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (isPredicateBoolean && config.layout.operatorPosition === 'leading') {
			// Break BEFORE the AND/OR so it leads the continuation line.
			// +1 indent puts the operator at the same depth as whatever
			// ON/WHERE/HAVING line it chains off, keeping the predicate
			// block visually coherent regardless of the parent clause's
			// own indent.
			//
			// Inside an `on (...)` multi-predicate paren we already added
			// +1 indent when the paren opened (the body sits at predicate
			// indent already), so the AND/OR should NOT add another +1 —
			// otherwise the operator floats one column deeper than its
			// fellow predicates. Skip the continuation bump in that case.
			const insideOnParen = indentingParenIsOn.length > 0
				&& indentingParenIsOn[indentingParenIsOn.length - 1];
			pendingNewline = true;
			oneShotExtraIndent = insideOnParen ? 0 : 1;
			// Mark the next line as a predicate-boolean continuation so a
			// nested arithmetic break inside it knows to indent one step
			// deeper than this AND/OR (wrap-of-wrap), not align with it.
			oneShotIsBooleanContinuation = !insideOnParen;
		} else if (mustWrapWideExprOps.has(tok.start) && config.layout.operatorPosition === 'leading') {
			// Wide-expression arithmetic break (leading): break BEFORE the
			// top-level operator so it leads the continuation line.
			// Triggered only when the target has no CASE/window/subquery
			// — those have their own wraps.
			//
			// Indent: a SELECT-target arithmetic break is the FIRST wrap
			// of that target, so the continuation aligns with the target
			// at +1. An AND-predicate arithmetic break, on the other hand,
			// already sits on a line that's itself a wrap of the boolean
			// chain — so the arithmetic continuation is a wrap-of-wrap
			// and goes one step deeper. We can't distinguish the two from
			// `currentLineExtraIndent` alone (both are 1), so the boolean
			// path opts in via `currentLineIsBooleanContinuation`.
			pendingNewline = true;
			oneShotExtraIndent = currentLineIsBooleanContinuation
				? currentLineExtraIndent + 1
				: 1;
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

		// Leading-comma mode: when a list-clause (SELECT / GROUP BY / ORDER
		// BY) must wrap, emit a newline BEFORE the comma so it leads the
		// continuation line. Short lists stay inline unchanged. One-shot
		// extra indent keeps the commas visually aligned with subsequent
		// targets.
		if (isListClauseComma
			&& config.layout.commaPosition === 'leading'
			&& inListClauseWrapRange
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
				const wasOn = indentingParenIsOn.pop() ?? false;
				indentLevel = Math.max(0, indentLevel - 1 - extra);
				// Wide-window `over (...)` close lands at the SAME column as
				// the `over (` line (the select-list-continuation column),
				// not the outer base. Restoring `+extra` for the R_PAREN's
				// emit produces the canonical sqlfluff layout where `) as
				// alias` aligns with the function call's `over`. Other
				// indenting parens (CTE bodies, subqueries, IN-subqueries)
				// close at the outer base regardless of the opener's
				// continuation indent — that's the established convention.
				if ((wasWindow || wasOn) && extra > 0) oneShotExtraIndent = extra;
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
				indentingParenIsOn.push(logicalPredicateParens.has(tok.start));
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
		} else if (isListClauseComma) {
			// Break only when the clause must wrap. Short forms stay on one
			// line; wide forms (or alwaysWrap-toggled ones) wrap.
			// `commaPosition: 'leading'` is handled BEFORE the comma emission
			// (see earlier in the loop); trailing fires here, after.
			if (inListClauseWrapRange && config.layout.commaPosition === 'trailing') {
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
			// the trigger is line-length overflow or the `alwaysWrap.select`
			// toggle.
			//
			// Exception: when SELECT is immediately followed by a modifier
			// keyword (DISTINCT / ALL), the modifier stays inline with
			// SELECT — `select distinct` reads as a unit. The wrap fires on
			// the modifier instead so the first target still lands on a
			// fresh indented line.
			const nextType = peekNextSqlTokenType(stream, streamIndex);
			if (nextType !== 'DISTINCT' && nextType !== 'ALL') {
				pendingNewline = true;
				oneShotExtraIndent = 1;
			}
		} else if (
			(typeUpper === 'DISTINCT' || typeUpper === 'ALL')
			&& prevTypeUpper === 'SELECT'
			&& inAnyRange(tok.start, mustWrapSelectRanges)
		) {
			// SELECT modifier in wrap mode: emit inline (`select distinct`),
			// then queue the wrap for the next token (the first target).
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (
			(typeUpper === 'GROUP_BY' || (typeUpper === 'BY' && prevTypeUpper === 'GROUP'))
			&& inAnyRange(tok.start, mustWrapGroupByRanges)
			&& !indentingParenIsWindow.some(Boolean)
		) {
			// GROUP BY in wrap mode: same shape as SELECT — keyword stays on
			// its own line, each target lands below at +1 indent. Handles
			// both the compound `GROUP_BY` token and the bare two-token
			// `GROUP` + `BY` form. Skipped when nested inside an `OVER(...)`
			// window — those clauses are governed by `alwaysWrap.window*`,
			// not the top-level toggle.
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (
			(typeUpper === 'ORDER_BY' || (typeUpper === 'BY' && prevTypeUpper === 'ORDER'))
			&& inAnyRange(tok.start, mustWrapOrderByRanges)
			&& !indentingParenIsWindow.some(Boolean)
		) {
			// ORDER BY in wrap mode: same as GROUP BY. The OVER-paren guard
			// is in the main walk rather than the pre-pass because window
			// detection relies on the runtime `indentingParenIsWindow`
			// stack — the stream-level scoping in `computeMustWrapListClauses`
			// is a best-effort filter, but the runtime stack is authoritative.
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (typeUpper === 'WHERE' && alwaysWrapWhereStarts.has(tok.start)) {
			// `alwaysWrap.where` with 2+ predicates: push the first predicate
			// onto its own indented line so WHERE sits alone on its line.
			// Subsequent predicates are wrapped by the operator-position
			// machinery (the AND/OR break path).
			pendingNewline = true;
			oneShotExtraIndent = 1;
		} else if (typeUpper === 'HAVING' && alwaysWrapHavingStarts.has(tok.start)) {
			// Same as WHERE — keyword on own line, predicates indented.
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

	// (Previous versions also injected a trailing comma here, after the
	// last SELECT target in a FROM-first / end-of-stream SELECT. Removed
	// for the same reason as the in-loop site above — neither sqlfmt nor
	// the current dbt-labs guide put a trailing comma after the final
	// target.)

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
	alwaysWrapCase: boolean,
): Set<number> {
	const out = new Set<number>();
	const indentWidth = policy.at(1).length || 4;

	// `alwaysWrap.case`: force-flag every TOP-LEVEL CASE-start regardless of
	// width. We still walk the stream below to maintain the SELECT-zone
	// accounting for the width-driven path, but a forced pass up front
	// catches CASEs the width-driven pass would otherwise skip (e.g. ones
	// outside SELECT zones).
	//
	// Scoping: a CASE that lives inside a function-call paren (e.g.
	// `max(case when ... end)`) is an embedded expression — its parent
	// SELECT target is the function call, not the CASE. Force-wrapping it
	// mangles short inline CASEs into multi-line monsters and cascades
	// breaks through the outer expression. Skip those; the width-driven
	// pass below still catches them when they would actually overflow.
	if (alwaysWrapCase) {
		const funcParenStack: number[] = [];
		let scanParenDepth = 0;
		let scanPrevSqlType = '';
		for (let i = 0; i < stream.length; i++) {
			const tok = stream[i];
			if (tok.category !== 'sql') continue;
			const type = tok.type.toUpperCase();
			if (type === 'L_PAREN') {
				scanParenDepth++;
				if (!isIndentingParenOpen(stream, i, scanPrevSqlType)) {
					funcParenStack.push(scanParenDepth);
				}
				scanPrevSqlType = type;
				continue;
			}
			if (type === 'R_PAREN') {
				if (funcParenStack.length > 0
					&& funcParenStack[funcParenStack.length - 1] === scanParenDepth) {
					funcParenStack.pop();
				}
				scanParenDepth = Math.max(0, scanParenDepth - 1);
				scanPrevSqlType = type;
				continue;
			}
			if (type === 'CASE' && funcParenStack.length === 0) {
				out.add(tok.start);
			}
			scanPrevSqlType = type;
		}
	}

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
		// CASEs in the target that are NOT inside a function-call / grouping
		// paren — those are candidates the outer wrap can break apart so
		// inner CASEs (function arguments) stay inline. Always a subset of
		// `curCaseStarts`.
		curTopLevelCaseStarts: number[];
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
			// Prefer wrapping only the outer CASE(s) so inner CASEs nested
			// inside function calls (`max(case ... end)`) can stay inline.
			// Fall back to flagging every CASE when no outer CASE exists —
			// that's the lone-inner-CASE-in-function-call shape, and the
			// inner has to wrap itself or the line stays too long.
			const toFlag = zone.curTopLevelCaseStarts.length > 0
				? zone.curTopLevelCaseStarts
				: zone.curCaseStarts;
			for (const s of toFlag) out.add(s);
		}
		zone.curWidth = 0;
		zone.curTokenCount = 0;
		zone.curCaseStarts = [];
		zone.curTopLevelCaseStarts = [];
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
				curTopLevelCaseStarts: [],
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
				// Track top-level CASEs separately. `parenDepth ===
				// indentingParens.length` means we're not inside any
				// function-call / grouping paren — only inside CTE bodies
				// / subqueries, which are indenting.
				if (parenDepth === indentingParens.length) {
					z.curTopLevelCaseStarts.push(tok.start);
				}
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
	alwaysWrapWindowPartitionBy: boolean,
	alwaysWrapWindowOrderBy: boolean,
): Set<number> {
	const out = new Set<number>();
	const indentWidth = policy.at(1).length || 4;

	// Forced-wrap pass: flag any OVER(...) paren whose body contains a
	// PARTITION (BY) or ORDER (BY) at depth 0, depending on the toggles.
	// Runs independently of the width-driven pass below so windows outside
	// SELECT zones (e.g. inside QUALIFY) are still caught.
	if (alwaysWrapWindowPartitionBy || alwaysWrapWindowOrderBy) {
		for (let i = 0; i < stream.length; i++) {
			const tok = stream[i];
			if (tok.category !== 'sql') continue;
			if (tok.type.toUpperCase() !== 'L_PAREN') continue;
			// Find the preceding SQL token; must be OVER.
			let prevIdx = i - 1;
			while (prevIdx >= 0 && stream[prevIdx].category !== 'sql') prevIdx--;
			if (prevIdx < 0 || stream[prevIdx].type.toUpperCase() !== 'OVER') continue;
			// Scan forward inside the OVER paren, depth-0 relative to it.
			let depth = 1;
			let hasPartitionBy = false;
			let hasOrderBy = false;
			for (let j = i + 1; j < stream.length; j++) {
				const t = stream[j];
				if (t.category !== 'sql') continue;
				const tt = t.type.toUpperCase();
				if (tt === 'L_PAREN') { depth++; continue; }
				if (tt === 'R_PAREN') { depth--; if (depth === 0) break; continue; }
				if (depth === 1) {
					if (tt === 'PARTITION_BY' || tt === 'PARTITION') hasPartitionBy = true;
					else if (tt === 'ORDER_BY' || tt === 'ORDER') hasOrderBy = true;
				}
			}
			if ((alwaysWrapWindowPartitionBy && hasPartitionBy)
				|| (alwaysWrapWindowOrderBy && hasOrderBy)) {
				out.add(tok.start);
			}
		}
	}

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
		// `'select'` zones treat COMMA as the target boundary; `'predicate'`
		// zones (WHERE / HAVING / ON / WHEN) treat AND/OR as the boundary.
		// Same width-driven wrap logic applies either way — each sub-target
		// gets its own width measurement and arithmetic-break candidate.
		kind: 'select' | 'predicate';
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
				kind: 'select',
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

		// Predicate zone: WHERE / HAVING / ON / WHEN — each sub-predicate
		// (separated by top-level AND/OR) is a "target" for the wide-
		// expression wrap. A predicate whose collapsed form overflows
		// gets a break inserted at its highest-priority arithmetic
		// operator, same shape as SELECT-target wrapping.
		//
		// Don't push another predicate zone when one is already active —
		// inner CASE WHENs inside the outer predicate's body should be
		// counted toward the OUTER predicate's width, not steal it into
		// their own zone. Without this guard, expressions like
		// `sum(case when X then Y end) - ceiling(...)` undercount because
		// the inner WHEN zone "ate" the inner body's tokens.
		if (type === 'WHERE' || type === 'HAVING' || type === 'ON' || type === 'WHEN') {
			const insidePredicate = zones.some(z => z.kind === 'predicate');
			if (!insidePredicate) {
				zones.push({
					kind: 'predicate',
					openedAtDepth: parenDepth,
					baseIndentLevel: indentLevel,
					curWidth: 0,
					curTokenCount: 0,
					curArithmeticOps: [],
					curHasCase: false,
					curHasWindow: false,
					curHasSubquery: false,
				});
			}
			prevSqlType = type;
			continue;
		}

		if (zones.length > 0) {
			const z = zones[zones.length - 1];
			if (parenDepth === z.openedAtDepth) {
				// Target boundary: COMMA for select zones, AND/OR for
				// predicate zones. Closes the current sub-target and
				// starts measurement of the next.
				const isTargetBoundary = z.kind === 'select'
					? type === 'COMMA'
					: (type === 'AND' || type === 'OR');
				if (isTargetBoundary) {
					flushTarget(z);
					prevSqlType = type;
					continue;
				}
				// Clause end: closes the zone entirely. THEN closes a WHEN
				// predicate zone (the THEN-side value isn't a predicate
				// anymore).
				const isClauseEnd = SELECT_LIST_END_KEYWORDS.has(type)
					|| (z.kind === 'predicate' && type === 'THEN');
				if (isClauseEnd) {
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
			// SELECT zones: any CASE in the target disqualifies it from
			// arithmetic-wrap — `mustWrapCases` expands the CASE
			// vertically, which usually makes the outer expression's
			// trailing line short again. Wrapping arithmetic on top would
			// double-wrap.
			//
			// Predicate zones: only TOP-LEVEL CASEs disqualify. An inner
			// CASE inside a function call (`sum(case ... end) > 0`) is an
			// embedded expression — the outer arithmetic still needs to
			// wrap on its own because `mustWrapCases` won't help (embedded
			// CASEs stay inline).
			if (type === 'CASE') {
				const caseRelevant = z.kind === 'select' || parenDepth === z.openedAtDepth;
				if (caseRelevant) z.curHasCase = true;
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
	alwaysWrapSelect: boolean,
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
			// Width-driven by default: wrap only when the collapsed form would
			// overflow `maxLineLength`. The `alwaysWrap.select` toggle adds a
			// second trigger: force the wrap whenever the SELECT has 2+ targets,
			// regardless of width. Same shape either way — the trigger is the
			// only difference.
			if (projected > maxLineLength || (alwaysWrapSelect && topLevelCommas >= 1)) {
				ranges.push({ start: tok.start, end: lastEnd, openedAtDepth: parenDepth });
			}
			prevSqlType = type;
			continue;
		}

		prevSqlType = type;
	}

	return ranges;
}

/**
 * Generic list-clause must-wrap, used for GROUP BY and ORDER BY (clauses
 * shaped as `KEYWORD target1, target2, ...`). Width-driven by default —
 * produces a range when the collapsed single-line projection exceeds
 * `maxLineLength`. The `alwaysWrap` flag adds a second trigger: force-wrap
 * when the clause has 2+ targets, regardless of width.
 *
 * `openers` is the set of compound clause-keyword types (e.g. `GROUP_BY`).
 * The bare two-token form (`GROUP` + `BY`) is recognised when `BY` is seen
 * with the matching prefix as its previous SQL token.
 */
function computeMustWrapListClauses(
	stream: NinjaSqlToken[],
	maxLineLength: number,
	policy: IndentPolicy,
	openers: Set<string>,
	alwaysWrap: boolean,
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
	const indentWidth = policy.at(1).length || 4;

	// Bare-prefix mapping: `GROUP_BY` ↔ `GROUP` + `BY` two-token form.
	const barePrefixes = new Set<string>();
	for (const k of openers) {
		if (k.endsWith('_BY')) barePrefixes.add(k.slice(0, -3));
	}

	let parenDepth = 0;
	let indentLevel = 0;
	const indentingParens: number[] = [];
	let prevSqlType = '';
	// Track OVER paren spans so we can skip openers inside windows — those
	// are governed by `alwaysWrap.windowPartitionBy` / `windowOrderBy`, not
	// by the top-level `alwaysWrap.groupBy` / `orderBy` toggles.
	const overParenDepths: number[] = [];

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			if (prevSqlType === 'OVER') overParenDepths.push(parenDepth);
			if (isIndentingParenOpen(stream, i, prevSqlType)) {
				indentLevel++;
				indentingParens.push(parenDepth);
			}
			prevSqlType = type;
			continue;
		}
		if (type === 'R_PAREN') {
			if (overParenDepths.length > 0 && overParenDepths[overParenDepths.length - 1] === parenDepth) {
				overParenDepths.pop();
			}
			if (indentingParens.length > 0 && indentingParens[indentingParens.length - 1] === parenDepth) {
				indentingParens.pop();
				indentLevel = Math.max(0, indentLevel - 1);
			}
			parenDepth = Math.max(0, parenDepth - 1);
			prevSqlType = type;
			continue;
		}

		const isOpener = openers.has(type)
			|| (type === 'BY' && barePrefixes.has(prevSqlType));
		if (!isOpener || overParenDepths.length > 0) {
			prevSqlType = type;
			continue;
		}

		// Scan forward through targets, stopping at the next depth-0 clause
		// boundary (any SELECT_LIST_END_KEYWORDS keyword that is NOT our own
		// opener — the opener filter prevents a freshly-emitted GROUP/BY
		// from being mistaken for a boundary).
		let depth = 0;
		let widthChars = tok.end - tok.start + 1;
		let tokenCount = 1;
		let lastEnd = tok.end;
		let topLevelCommas = 0;
		for (let j = i + 1; j < stream.length; j++) {
			const t = stream[j];
			if (t.category !== 'sql') continue;
			const tt = t.type.toUpperCase();
			if (tt === 'L_PAREN') { depth++; }
			else if (tt === 'R_PAREN') {
				if (depth === 0) break;
				depth--;
			}
			if (depth === 0 && SELECT_LIST_END_KEYWORDS.has(tt)
				&& !openers.has(tt)
				&& !(tt === 'BY' && barePrefixes.has(stream[j - 1]?.category === 'sql' ? stream[j - 1].type.toUpperCase() : ''))) break;
			if (depth === 0 && tt === 'COMMA') topLevelCommas++;
			widthChars += t.end - t.start + 1;
			tokenCount++;
			lastEnd = t.end;
		}
		const projected = indentLevel * indentWidth + widthChars + Math.max(0, tokenCount - 1);
		if (topLevelCommas >= 1 && (projected > maxLineLength || alwaysWrap)) {
			ranges.push({ start: tok.start, end: lastEnd });
		}

		prevSqlType = type;
	}
	return ranges;
}

/**
 * Token-stream pass that finds comma offsets inside a list clause
 * (`GROUP BY` / `ORDER BY`) at the clause's own paren depth. Mirrors
 * `computeSelectListCommas` for clauses with the same target-list shape.
 * Used by the main walk to recognise commas that should be wrapped when
 * the clause is in a must-wrap range.
 */
function computeListClauseCommas(stream: NinjaSqlToken[], openers: Set<string>): Set<number> {
	const out = new Set<number>();
	const barePrefixes = new Set<string>();
	for (const k of openers) {
		if (k.endsWith('_BY')) barePrefixes.add(k.slice(0, -3));
	}
	const zones: Array<{ openedAtDepth: number }> = [];
	const overParenDepths: number[] = [];
	let parenDepth = 0;
	let prevType = '';

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') {
			parenDepth++;
			if (prevType === 'OVER') overParenDepths.push(parenDepth);
			prevType = type;
			continue;
		}
		if (type === 'R_PAREN') {
			if (overParenDepths.length > 0 && overParenDepths[overParenDepths.length - 1] === parenDepth) {
				overParenDepths.pop();
			}
			parenDepth = Math.max(0, parenDepth - 1);
			while (zones.length > 0 && zones[zones.length - 1].openedAtDepth > parenDepth) zones.pop();
			prevType = type;
			continue;
		}

		const isOpener = openers.has(type)
			|| (type === 'BY' && barePrefixes.has(prevType));
		if (isOpener && overParenDepths.length === 0) {
			zones.push({ openedAtDepth: parenDepth });
			prevType = type;
			continue;
		}

		if (type === 'COMMA' && zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth === top.openedAtDepth) out.add(tok.start);
			prevType = type;
			continue;
		}

		if (zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth === top.openedAtDepth && SELECT_LIST_END_KEYWORDS.has(type)
				&& !openers.has(type)
				&& !(type === 'BY' && barePrefixes.has(prevType))) {
				zones.pop();
			}
		}
		prevType = type;
	}
	return out;
}

/**
 * Walks the stream looking for `clauseType` (WHERE / HAVING) keyword tokens
 * and, for any clause that carries 2+ predicates joined by `AND`/`OR`,
 * returns:
 *   - `keywordStarts`: the keyword's start offset (so the printer emits a
 *     newline AFTER the keyword and pushes the first predicate onto an
 *     indented line).
 *   - `forcedBooleans`: the start offsets of every `AND`/`OR` in that
 *     clause at the clause's own depth. The main walk merges these into
 *     `predicateBooleanOffsets` so the operator-position machinery wraps
 *     each predicate onto its own line — even when the source had the
 *     predicates on a single line (the regular `computePredicateBooleans`
 *     fallback only flags AND/OR whose source already crossed a line).
 *
 * Fires only when `enabled` (the corresponding `alwaysWrap.{where,having}`
 * toggle). Single-predicate clauses stay inline (`where x = 1`).
 */
function computeAlwaysWrapPredicateClauses(
	stream: NinjaSqlToken[],
	clauseType: 'WHERE' | 'HAVING',
	enabled: boolean,
): { keywordStarts: Set<number>; forcedBooleans: Set<number> } {
	const keywordStarts = new Set<number>();
	const forcedBooleans = new Set<number>();
	if (!enabled) return { keywordStarts, forcedBooleans };

	let parenDepth = 0;

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') { parenDepth++; continue; }
		if (type === 'R_PAREN') { parenDepth = Math.max(0, parenDepth - 1); continue; }
		if (type !== clauseType) continue;

		// Collect AND/OR offsets at the clause's depth before the next
		// clause boundary. CASE/END inner spans suppress collection so
		// AND/OR inside a CASE expression don't fool the detection.
		let innerDepth = 0;
		let innerCase = 0;
		const candidateBooleans: number[] = [];
		for (let j = i + 1; j < stream.length; j++) {
			const t = stream[j];
			if (t.category !== 'sql') continue;
			const tt = t.type.toUpperCase();
			if (tt === 'L_PAREN') { innerDepth++; continue; }
			if (tt === 'R_PAREN') {
				if (innerDepth === 0) break;
				innerDepth--;
				continue;
			}
			if (tt === 'CASE' || tt === 'IF') { innerCase++; continue; }
			if (tt === 'END') { if (innerCase > 0) innerCase--; continue; }
			if (innerDepth === 0 && innerCase === 0 && SELECT_LIST_END_KEYWORDS.has(tt)) break;
			if (innerDepth === 0 && innerCase === 0 && (tt === 'AND' || tt === 'OR')) {
				candidateBooleans.push(t.start);
			}
		}
		if (candidateBooleans.length >= 1) {
			keywordStarts.add(tok.start);
			for (const s of candidateBooleans) forcedBooleans.add(s);
		}
	}
	return { keywordStarts, forcedBooleans };
}

/**
 * Returns the set of THEN token offsets whose preceding WHEN condition
 * spans multiple lines in the formatter output — either because the
 * condition contains source-driven predicate-boolean wraps
 * (`predicateBooleanOffsets`) or width-driven arithmetic wraps
 * (`mustWrapWideExprOps`). Those THENs need their own indented line,
 * matching sqlfluff's `indented_then`. Used as a token-stream fallback
 * when the AST path (`enclosing.includes('Case')`) is unavailable.
 */
function computeMultiLineWhenThens(
	stream: NinjaSqlToken[],
	predicateBooleanOffsets: Set<number>,
	mustWrapWideExprOps: Set<number>,
): Set<number> {
	const out = new Set<number>();
	const whenStack: Array<{ openedAtDepth: number; hasBreak: boolean }> = [];
	let parenDepth = 0;

	for (const tok of stream) {
		// Jinja tokens inside a WHEN body force newlines around their tag,
		// so the THEN ends up on its own line — count as a break.
		if (tok.category !== 'sql') {
			if (whenStack.length > 0) {
				whenStack[whenStack.length - 1].hasBreak = true;
			}
			continue;
		}
		// Comments are attached to adjacent SQL tokens via tok.comments
		// (sqlglot doesn't emit standalone COMMENT tokens). When any token
		// inside a WHEN body — including the THEN itself — carries comments,
		// the formatter has to emit those comments on their own lines, which
		// forces THEN onto a new line. Mark the WHEN multi-line so the THEN
		// gets `indented_then` treatment instead of sitting at WHEN's column.
		if (whenStack.length > 0 && tok.comments && tok.comments.length > 0) {
			whenStack[whenStack.length - 1].hasBreak = true;
		}
		const type = tok.type.toUpperCase();

		if (type === 'L_PAREN') { parenDepth++; continue; }
		if (type === 'R_PAREN') {
			parenDepth = Math.max(0, parenDepth - 1);
			while (whenStack.length > 0 && whenStack[whenStack.length - 1].openedAtDepth > parenDepth) {
				whenStack.pop();
			}
			continue;
		}

		if (type === 'WHEN') {
			whenStack.push({ openedAtDepth: parenDepth, hasBreak: false });
			continue;
		}

		if (type === 'THEN' && whenStack.length > 0) {
			const top = whenStack[whenStack.length - 1];
			if (top.openedAtDepth === parenDepth) {
				if (top.hasBreak) out.add(tok.start);
				whenStack.pop();
			}
			continue;
		}

		// Any break inside the current WHEN's body marks the WHEN as
		// multi-line. Counts both AND/OR predicate breaks (source-driven)
		// and wide-arithmetic breaks (width-driven).
		if (whenStack.length > 0
			&& (predicateBooleanOffsets.has(tok.start) || mustWrapWideExprOps.has(tok.start))
		) {
			whenStack[whenStack.length - 1].hasBreak = true;
		}
	}
	return out;
}

function peekNextSqlTokenTypeAt(stream: NinjaSqlToken[], start: number): string | undefined {
	for (let i = start + 1; i < stream.length; i++) {
		if (stream[i].category === 'sql') return stream[i].type.toUpperCase();
	}
	return undefined;
}

/**
 * General-case detection for parentheses that wrap a logical (AND/OR)
 * predicate group — applies in WHERE, HAVING, JOIN ON, CASE WHEN
 * conditions, or anywhere else a `(` contains an AND/OR chain at its body
 * depth.
 *
 * A `(` qualifies when:
 *   - Structural: the body contains AND/OR at depth 0 relative to the
 *     paren (not deeper inside nested parens — those are sub-groups).
 *   - Not a function-call paren (prev SQL token is not VAR/IDENTIFIER).
 *   - Not a subquery (the body's first SQL token isn't SELECT).
 *   - Trigger: at least one of those AND/ORs is on a different source line
 *     than its neighbours (already in `predicateBooleanOffsets`), OR the
 *     collapsed body would overflow `maxLineLength`.
 *
 * Returns:
 *   - `parenStarts`: L_PAREN offsets that should open as an indenting
 *     body (printer emits `(`, newline + indented body, `)` on its own
 *     line at the opener's column).
 *   - `breakOffsets`: AND/OR offsets inside those parens that should fire
 *     predicate-boolean breaks (merged into the printer's
 *     `predicateBooleanOffsets` so the operator-position machinery wraps
 *     each predicate onto its own line).
 */
function computeLogicalPredicateParens(
	stream: NinjaSqlToken[],
	maxLineLength: number,
): { parenStarts: Set<number>; breakOffsets: Set<number> } {
	const parenStarts = new Set<number>();
	const breakOffsets = new Set<number>();

	// Index of SQL tokens for fast prev/next neighbour lookup (used for
	// source-line crossing detection on candidate AND/ORs).
	const sqlIdx: number[] = [];
	for (let i = 0; i < stream.length; i++) {
		if (stream[i].category === 'sql') sqlIdx.push(i);
	}
	const sqlPos = new Map<number, number>();
	for (let k = 0; k < sqlIdx.length; k++) sqlPos.set(sqlIdx[k], k);

	for (let i = 0; i < stream.length; i++) {
		const tok = stream[i];
		if (tok.category !== 'sql') continue;
		if (tok.type.toUpperCase() !== 'L_PAREN') continue;

		// Skip function-call parens — `coalesce(a and b, c)` is not a
		// logical group; the parens belong to the function call.
		let prevSqlType = '';
		for (let j = i - 1; j >= 0; j--) {
			if (stream[j].category === 'sql') { prevSqlType = stream[j].type.toUpperCase(); break; }
		}
		if (prevSqlType === 'VAR' || prevSqlType === 'IDENTIFIER') continue;

		// Find matching ).
		let d = 1;
		let matchIdx = -1;
		for (let k = i + 1; k < stream.length; k++) {
			if (stream[k].category !== 'sql') continue;
			const t = stream[k].type.toUpperCase();
			if (t === 'L_PAREN') d++;
			else if (t === 'R_PAREN') { d--; if (d === 0) { matchIdx = k; break; } }
		}
		if (matchIdx < 0) continue;

		// Skip subqueries — body starts with SELECT. Those are already
		// handled by the CTE/subquery indenting paren path.
		let firstBodySqlType = '';
		for (let k = i + 1; k < matchIdx; k++) {
			if (stream[k].category === 'sql') { firstBodySqlType = stream[k].type.toUpperCase(); break; }
		}
		if (firstBodySqlType === 'SELECT') continue;

		// Scan body for AND/OR at body depth (depth 0 relative to opener),
		// collecting them and projecting collapsed body width. For each
		// candidate also check whether its source position crosses a line
		// boundary — that's the signal we use to decide "wrap me."
		let bd = 0;
		const bodyAndOr: number[] = [];
		let sourceMultiLineAndOr = false;
		let widthChars = 0;
		let tokenCount = 0;
		for (let k = i + 1; k < matchIdx; k++) {
			const t = stream[k];
			if (t.category !== 'sql') continue;
			const tt = t.type.toUpperCase();
			if (tt === 'L_PAREN') { bd++; widthChars += t.end - t.start + 1; tokenCount++; continue; }
			if (tt === 'R_PAREN') { bd--; widthChars += t.end - t.start + 1; tokenCount++; continue; }
			if (bd === 0 && (tt === 'AND' || tt === 'OR')) {
				bodyAndOr.push(t.start);
				// Source-line cross check, same shape as
				// computePredicateBooleans uses.
				const kk = sqlPos.get(k)!;
				const prev = kk > 0 ? stream[sqlIdx[kk - 1]] : undefined;
				const next = kk < sqlIdx.length - 1 ? stream[sqlIdx[kk + 1]] : undefined;
				if ((prev && prev.line !== t.line) || (next && next.line !== t.line)) {
					sourceMultiLineAndOr = true;
				}
			}
			widthChars += t.end - t.start + 1;
			tokenCount++;
		}
		if (bodyAndOr.length === 0) continue;

		const projected = widthChars + Math.max(0, tokenCount - 1);
		const triggerWrap = sourceMultiLineAndOr || projected > maxLineLength;
		if (!triggerWrap) continue;

		parenStarts.add(tok.start);
		for (const off of bodyAndOr) breakOffsets.add(off);
	}

	return { parenStarts, breakOffsets };
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
	const zones: Array<{ openedAtDepth: number; openerType: string }> = [];
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

		if (type === 'WHERE' || type === 'HAVING' || type === 'ON' || type === 'WHEN') {
			zones.push({ openedAtDepth: parenDepth, openerType: type });
			continue;
		}
		// THEN closes the WHEN's predicate zone — the AND/OR after THEN
		// is no longer predicate-related (it's a value expression).
		if (type === 'THEN' && zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth === top.openedAtDepth && top.openerType === 'WHEN') zones.pop();
		}

		if (zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth === top.openedAtDepth && ZONE_END.has(type)) {
				zones.pop();
			}
		}

		if ((type === 'AND' || type === 'OR') && zones.length > 0) {
			const top = zones[zones.length - 1];
			if (parenDepth !== top.openedAtDepth) continue;
			// AND/OR inside a CASE branch (then/else) is a value expression,
			// not a predicate — suppress. EXCEPT when the active zone is a
			// WHEN condition itself (its AND/OR IS the predicate chain).
			if (caseDepth > 0 && top.openerType !== 'WHEN') continue;

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
function computeMultiPredicateJoinOnRanges(
	stream: NinjaSqlToken[],
): {
	ranges: Array<{ start: number; end: number }>;
	breakOffsets: Set<number>;
	wrapParenStarts: Set<number>;
} {
	const ranges: Array<{ start: number; end: number }> = [];
	const breakOffsets = new Set<number>();
	// Offsets of `(` tokens that wrap an ENTIRE multi-predicate JOIN-ON
	// chain. Only those should be treated as indenting parens — when a
	// `(` only wraps one of several sibling predicates (`on (a or b) and
	// c`), the paren is just expression grouping, not an indentable body.
	const wrapParenStarts = new Set<number>();
	let parenDepth = 0;
	let prevTypeUpper = '';
	// Active join chain state. null when not inside a JOIN-ON/USING chain.
	// `candidateBreaks` collects AND/OR offsets at the predicate's TOP level
	// (chain.joinDepth or chain.joinDepth + 1) — those are the operators
	// that should break onto their own lines when the chain wraps.
	let chain: {
		joinDepth: number;
		onStart: number;
		hasAndOr: boolean;
		lastTokEnd: number;
		candidateBreaks: number[];
	} | null = null;
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
			for (const off of chain.candidateBreaks) breakOffsets.add(off);
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
				candidateBreaks: [],
			};
			// Check whether the next SQL token is `(` and whether the
			// matching `)` is followed by nothing more in the chain. If
			// both, the `(` wraps the entire predicate body and qualifies
			// as an indenting paren.
			let nextSqlIdx = -1;
			for (let k = i + 1; k < stream.length; k++) {
				if (stream[k].category === 'sql') { nextSqlIdx = k; break; }
			}
			if (nextSqlIdx >= 0 && stream[nextSqlIdx].type.toUpperCase() === 'L_PAREN') {
				// Find matching `)`.
				let d = 1;
				let matchIdx = -1;
				for (let k = nextSqlIdx + 1; k < stream.length; k++) {
					if (stream[k].category !== 'sql') continue;
					const t = stream[k].type.toUpperCase();
					if (t === 'L_PAREN') d++;
					else if (t === 'R_PAREN') { d--; if (d === 0) { matchIdx = k; break; } }
				}
				if (matchIdx >= 0) {
					// After the matching `)`, scan forward at parenDepth ===
					// chain.joinDepth for content. Anything other than a
					// chain-ender means there are sibling predicates and the
					// `(` is NOT a wrap.
					let isWrap = true;
					for (let k = matchIdx + 1; k < stream.length; k++) {
						if (stream[k].category !== 'sql') continue;
						const t = stream[k].type.toUpperCase();
						if (JOIN_START.has(t) && !JOIN_CONTINUATION_PREV.has('R_PAREN')) break;
						if (MAJOR_CLAUSES.has(t)) break;
						// Any other SQL token at this point is sibling content.
						isWrap = false;
						break;
					}
					if (isWrap) wrapParenStarts.add(stream[nextSqlIdx].start);
				}
			}
			scanningJoin = null;
			prevTypeUpper = type;
			continue;
		}

		// Inside an open chain, track AND/OR at the chain's depth or exactly
		// one paren deeper. The +1 case catches predicates wrapped in an
		// outer paren (`on ((... and ...) or (... and ...))`) — the OR
		// between the two inner parens sits at chain.joinDepth + 1. Deeper
		// nesting (the AND inside each inner paren) is NOT flagged: those
		// AND/ORs are inside a single sub-predicate group and should stay
		// inline.
		if (chain) {
			if ((type === 'AND' || type === 'OR')
				&& (parenDepth === chain.joinDepth || parenDepth === chain.joinDepth + 1)
			) {
				chain.hasAndOr = true;
				chain.candidateBreaks.push(tok.start);
			}
			chain.lastTokEnd = tok.end;
		}

		prevTypeUpper = type;
	}

	// End of stream closes any open chain.
	if (chain) closeChain();

	return { ranges, breakOffsets, wrapParenStarts };
}

/** True when `offset` falls inside any of the provided byte ranges. */
function inAnyRange(offset: number, ranges: Array<{ start: number; end: number }>): boolean {
	for (const r of ranges) {
		if (offset >= r.start && offset <= r.end) return true;
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
