import type { NinjaConfig } from '../config';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import type { AstPayload } from '../../ftl/parse-result';
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

	const parts: string[] = [];
	const cap = createCapitalisationState(symbols);

	let parenDepth = 0;
	let indentLevel = 0;
	// Stack of paren-depth markers for parens that opened a CTE body or
	// subquery and therefore increased `indentLevel`. On the matching
	// close paren we pop and decrement, so nested function calls inside a
	// CTE body don't touch indent.
	const indentingParens: number[] = [];
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

	// One-shot extra indent used for `indented_on` / `indented_then` /
	// `indented_joins`: consumed by the next `emitNewline()` and then
	// reset to 0, so only the single line introduced by the trigger
	// token receives the deeper indent.
	let oneShotExtraIndent = 0;

	const emitNewline = (): void => {
		if (atLineStart && parts.length === 0) return;
		parts.push('\n');
		parts.push(policy.at(indentLevel + oneShotExtraIndent));
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
			// After: hug the preceding token with a single space.
			emitSpace();
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
			if (!atLineStart) emitSpace();
			const rawTag = source.slice(tok.start, tok.tagEnd);
			parts.push(normaliseTagSpacing(rawTag) ?? rawTag);
			atLineStart = false;
			prev = tok;
			prevTypeUpper = 'JINJA';
			continue;
		}

		const typeUpper = tok.type.toUpperCase();
		const literal = source.slice(tok.start, tok.end + 1);

		// ── Leading comments ──────────────────────────────────────────────
		// Comments whose byte range precedes the owning token were attached
		// by sqlglot's tokenizer as "leading" — they belong ABOVE this
		// token in the output. Drain them now before the clause/spacing
		// logic runs, so they inherit the current indent level.
		if (tok.comments?.length) {
			for (const c of tok.comments) {
				if (c.start < tok.start) {
					emitComment(source.slice(c.start, c.end), 'before');
				}
			}
			if (pendingNewline) {
				emitNewline();
				pendingNewline = false;
			}
		}

		// ── AST-informed role queries ─────────────────────────────────────
		// These answer "what is this token's structural role?" using byte-
		// range ancestry. Empty index (no AST) falls through to pure
		// token-stream heuristics below.
		const innermost = astIndex.empty ? undefined : astIndex.innermostClass(tok.start);
		const enclosing = astIndex.empty ? [] : astIndex.enclosingClasses(tok.start);
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
					&& peekNextSqlTokenType(stream, streamIndex) === 'SELECT'));
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
		let isJoinOnOrUsing = false;
		if ((typeUpper === 'ON' || typeUpper === 'USING')
			&& enclosing.includes('Join')
			&& policy.indentedOn
		) {
			const join = astIndex.findEnclosing(tok.start, 'Join');
			if (join && astIndex.containsAny(join.start, join.end, ['And', 'Or'])) {
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
			: false;

		// ── Clause/JOIN/set-op newline injection ──────────────────────────
		if (nonIndentingParenDepth === 0 && parts.length > 0) {
			if (MAJOR_CLAUSES.has(typeUpper)) {
				// Trailing-comma policy: when the SELECT list wrapped (each target
				// on its own line) and we're about to emit the clause keyword that
				// ends the list, inject a trailing comma after the last target so
				// `convention.trailing-comma` stays clean on formatter output. The
				// previous token already landed inline; the comma hugs it before
				// the upcoming newline.
				if (config.layout.commaPosition === 'trailing'
					&& prev && prev.category === 'sql'
					&& prevTypeUpper !== 'COMMA'
					&& inAnyRange(prev.end, mustWrapSelectRanges)
				) {
					parts.push(',');
				}
				// Clear any one-shot indent the last target-comma queued —
				// FROM/WHERE/etc land at the clause's base indent, not the
				// target-continuation indent.
				oneShotExtraIndent = 0;
				pendingNewline = true;
			} else if (JOIN_START.has(typeUpper) && !JOIN_CONTINUATION_PREV.has(prevTypeUpper)) {
				pendingNewline = true;
				if (isIndentedJoinStart) oneShotExtraIndent = 1;
			} else if (SET_OPERATOR.has(typeUpper)) {
				pendingNewline = true;
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
		}
		// A CTE separator comma always breaks, even when nested inside the
		// WITH's top paren — that's the whole reason we need AST context
		// over pure paren-depth tracking.
		if (isCteSeparatorComma) {
			// Comma itself stays flush against the preceding token; newline
			// fires AFTER the comma so the next CTE name starts fresh.
			// Handled post-emit below.
		}

		// Leading-comma mode: when a SELECT list must wrap, emit a newline
		// BEFORE the comma so it leads the continuation line. Short lists
		// stay inline unchanged. One-shot extra indent keeps the commas
		// visually aligned with subsequent targets.
		if (isSelectListComma
			&& config.layout.commaPosition === 'leading'
			&& inAnyRange(tok.start, mustWrapSelectRanges)
		) {
			pendingNewline = true;
			oneShotExtraIndent = 1;
		}

		// Close-paren for a CTE body / subquery gets its own line at the
		// outer indent. We decrement `indentLevel` BEFORE the newline so
		// the paren lands flush with the CTE's `as`, not with its body.
		if (parenClosesIndent) {
			const top = indentingParens[indentingParens.length - 1];
			if (top === parenDepth) {
				indentingParens.pop();
				indentLevel = Math.max(0, indentLevel - 1);
			}
			pendingNewline = true;
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
				indentLevel++;
				indentingParens.push(parenDepth);
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
			// Insert a blank line between CTE definitions: emit an extra
			// newline immediately, then queue the regular pendingNewline
			// so the next CTE's name lands on a fresh indented line after
			// the blank. Common dbt style — makes large WITH blocks
			// readable.
			parts.push('\n');
			pendingNewline = true;
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
		} else if (isPredicateBoolean && config.layout.operatorPosition === 'trailing') {
			// Trailing mode: the AND/OR already landed inline; break
			// AFTER it so the next predicate starts a new indented line.
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
		}

		prev = tok;
		prevTypeUpper = typeUpper;
	}

	void indentLevel;

	let output = parts.join('');

	// Collapse trailing whitespace on each line — the only line-level trivia
	// worth enforcing unconditionally.
	output = output.replace(/[ \t]+$/gm, '');
	// Always end with a single trailing newline.
	if (!output.endsWith('\n')) output += '\n';
	return output;
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

/** Clause keywords (uppercased) that terminate a SELECT target list at depth 0. */
const SELECT_LIST_END_KEYWORDS = new Set([
	'FROM', 'WHERE', 'GROUP_BY', 'GROUP', 'HAVING',
	'ORDER_BY', 'ORDER', 'LIMIT', 'OFFSET', 'QUALIFY', 'WINDOW', 'FETCH',
]);

/** Previous-token types that mark an L_PAREN as an "indenting" body opener. */
const INDENTING_PAREN_PREV = new Set(['ALIAS', 'FROM', 'JOIN', 'EXISTS', 'IN', 'NOT_IN']);

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
): Array<{ start: number; end: number }> {
	const ranges: Array<{ start: number; end: number }> = [];
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
			// IN / NOT_IN followed by a SELECT (subquery, not scalar list).
			const isIndenting = INDENTING_PAREN_PREV.has(prevSqlType)
				&& (
					prevSqlType !== 'IN' && prevSqlType !== 'NOT_IN'
						? true
						: peekNextSqlTokenTypeAt(stream, i) === 'SELECT'
				);
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
				ranges.push({ start: tok.start, end: lastEnd });
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
