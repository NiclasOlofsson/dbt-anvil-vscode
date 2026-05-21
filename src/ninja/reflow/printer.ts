import type { NinjaConfig } from '../config';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import type { AstPayload } from '../../ftl/parse-result';
import type { DialectSymbols } from '../../ftl/sql-parser';
import type { IndentPolicy } from './indent-policy';
import { createCapitalisationState, recaseToken } from './capitalisation';
import { createAstIndex } from './ast-index';

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
	const mustWrapSelectRanges = computeMustWrapSelects(ast, stream, config.maxLineLength);

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
			parts.push(source.slice(tok.start, tok.tagEnd));
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
		// (again not inside a nested enclosure).
		const isSelectListComma = typeUpper === 'COMMA'
			&& enclosing.includes('Select')
			&& !hasInnerEnclosure(enclosing, 'Select', ['Paren', 'Func', 'Subquery', 'Anonymous', 'Where', 'Group', 'Order', 'Having']);
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
			? (enclosing.includes('Where') || enclosing.includes('Having') || enclosing.includes('Join'))
				&& !hasInnerEnclosureAny(enclosing, ['Where', 'Having', 'Join'], ['Case', 'If'])
			: false;

		// ── Clause/JOIN/set-op newline injection ──────────────────────────
		if (nonIndentingParenDepth === 0 && parts.length > 0) {
			if (MAJOR_CLAUSES.has(typeUpper)) {
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
		parts.push(recaseToken(tok.type, literal, config, cap, nextSqlTypeUpper));
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

/**
 * For each `Select` node in the AST, determine whether keeping its
 * SELECT list on a single line would exceed `maxLineLength`. When yes,
 * the byte range is returned — callers query it to decide whether a
 * SELECT-list comma must force a break.
 *
 * The width estimate is token-literal widths summed with one space
 * between each, plus the current paren/indent column. It's an upper
 * bound on the single-line form, so we may wrap a few borderline cases
 * — acceptable trade-off vs. a complex two-pass simulation.
 */
function computeMustWrapSelects(
	ast: AstPayload[],
	stream: NinjaSqlToken[],
	maxLineLength: number,
): Array<{ start: number; end: number }> {
	const selects = ast.filter(n => n.c === 'Select' && n.m?.start !== undefined && n.m?.end !== undefined);
	if (selects.length === 0) return [];

	const ranges: Array<{ start: number; end: number }> = [];
	for (const node of selects) {
		const start = node.m!.start!;
		const end = node.m!.end!;
		let width = 0;
		let count = 0;
		for (const tok of stream) {
			if (tok.category !== 'sql') continue;
			if (tok.start < start || tok.start > end) continue;
			width += tok.end - tok.start + 1;
			count++;
		}
		// Add one space between each token as a rough render estimate.
		width += Math.max(0, count - 1);
		if (width > maxLineLength) {
			ranges.push({ start, end });
		}
	}
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
