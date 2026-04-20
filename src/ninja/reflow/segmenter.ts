/**
 * Pass 1 of the reflow engine: converts a flat ninjaSqlTokens stream
 * into a structured segment tree.
 *
 * Strategy:
 * - Walk the token stream with a cursor.
 * - Clause keywords (SELECT, FROM, WHERE, …) open a new ClauseSegment.
 * - `WITH` opens a WithSegment; CTEs are collected until the final SELECT.
 * - `L_PAREN` / `R_PAREN` build nested ParenSegments.
 * - COMMA creates list boundaries within the current context.
 * - Jinja tokens are wrapped in JinjaSegments and treated as opaque atoms.
 * - `UNION`/`INTERSECT`/`EXCEPT` create SetOpSegments between statements.
 * - Comments are forwarded to CommentSegments.
 *
 * Limitation: subqueries inside FROM / WHERE are recognised by paren depth
 * but not recursively segmented — they appear as ParenSegments with
 * unsegmented bodies. This is sufficient for dbt models (almost no correlated
 * subqueries). Layer 3 v2 can recurse when needed.
 */

import type { SqlToken } from '../../ftl/parse-result';
import type { JinjaToken } from '../../ftl/jinja-tokenizer';
import type { NinjaSqlToken } from '../../ftl/ninja-sql-tokens';
import {
	type Segment, type TopLevelSegment, type ClauseSegment, type CteSegment,
	type WithSegment, type StatementSegment, type SetOpSegment,
} from './segments';

// ── Constants ────────────────────────────────────────────────────────────────

const CLAUSE_STARTERS = new Set([
	'SELECT', 'FROM', 'WHERE', 'GROUP', 'HAVING', 'ORDER', 'LIMIT', 'QUALIFY',
]);

const JOIN_WORDS = new Set([
	'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'CROSS', 'OUTER',
]);

const SET_OPERATORS = new Set(['UNION', 'INTERSECT', 'EXCEPT']);

// ── Cursor ───────────────────────────────────────────────────────────────────

class TokenCursor {
	private _pos = 0;
	constructor(
		private readonly tokens: NinjaSqlToken[],
		private readonly source: string,
	) {}

	peek(): NinjaSqlToken | undefined { return this.tokens[this._pos]; }
	peek2(): NinjaSqlToken | undefined { return this.tokens[this._pos + 1]; }
	has(): boolean { return this._pos < this.tokens.length; }

	next(): NinjaSqlToken {
		const t = this.tokens[this._pos++];
		if (!t) throw new Error('TokenCursor.next: past end');
		return t;
	}

	back(): void { if (this._pos > 0) this._pos--; }

	textOf(tok: NinjaSqlToken): string {
		if (tok.category === 'jinja') {
			return this.source.slice(tok.start, tok.end);
		}
		return this.source.slice(tok.start, tok.end + 1);
	}

	/** True when the current token is at the top level (not inside parens). */
	isClauseStarter(tok: NinjaSqlToken): boolean {
		if (tok.category !== 'sql') return false;
		return CLAUSE_STARTERS.has(tok.type) || JOIN_WORDS.has(tok.type);
	}

	isSetOp(tok: NinjaSqlToken): boolean {
		return tok.category === 'sql' && SET_OPERATORS.has(tok.type);
	}
}

// ── Entry ────────────────────────────────────────────────────────────────────

/**
 * Segment a flat ninjaSqlTokens stream into a structured top-level segment tree.
 * `source` is the raw document text (for extracting verbatim token text).
 */
export function segment(tokens: NinjaSqlToken[], source: string): TopLevelSegment[] {
	const cursor = new TokenCursor(tokens, source);
	const result: TopLevelSegment[] = [];

	while (cursor.has()) {
		const tok = cursor.peek()!;

		if (tok.category === 'sql' && tok.type === 'WITH') {
			cursor.next();
			result.push(parseWithBlock(cursor));
			continue;
		}

		if (cursor.isSetOp(tok)) {
			// Consume UNION [ALL|DISTINCT], INTERSECT, EXCEPT — emit as SetOpSegment.
			const opTokens: SqlToken[] = [];
			let opText = '';
			while (cursor.has()) {
				const t = cursor.peek()!;
				if (t.category !== 'sql') break;
				if (!cursor.isSetOp(t) && t.type !== 'ALL' && t.type !== 'DISTINCT') break;
				cursor.next();
				opTokens.push(t as SqlToken);
				opText += (opText ? ' ' : '') + cursor.textOf(t);
			}
			result.push({ type: 'setop', tokens: opTokens, text: opText } satisfies SetOpSegment);
			continue;
		}

		if (cursor.isClauseStarter(tok)) {
			const stmt = parseStatement(cursor);
			result.push(stmt);
			continue;
		}

		// Skip tokens that don't start recognised constructs (e.g. semicolons,
		// leading whitespace tokens that the lexer emits at certain positions).
		cursor.next();
	}

	return result;
}

// ── WITH block ───────────────────────────────────────────────────────────────

function parseWithBlock(cursor: TokenCursor): WithSegment {
	const ctes: CteSegment[] = [];

	// Collect CTEs: name AS ( body ) [,]
	while (cursor.has()) {
		const nameTok = cursor.peek();
		if (!nameTok || nameTok.category !== 'sql') break;
		if (nameTok.type === 'SELECT' || cursor.isSetOp(nameTok)) break;

		// Expect: VAR/identifier AS L_PAREN … R_PAREN [COMMA]
		if (nameTok.type !== 'VAR' && nameTok.type !== 'IDENTIFIER') {
			// Not a CTE name — must be start of final SELECT.
			break;
		}

		cursor.next(); // consume name
		const name = cursor.textOf(nameTok);

		// Skip optional AS keyword
		let nextTok = cursor.peek();
		if (nextTok?.category === 'sql' && nextTok.type === 'AS') cursor.next();

		// Expect L_PAREN
		nextTok = cursor.peek();
		if (nextTok?.category !== 'sql' || nextTok.type !== 'L_PAREN') break;
		cursor.next(); // consume L_PAREN

		const bodyTokens = collectUntilMatchingParen(cursor);
		const cteBody = segment(bodyTokens, /* will recompute inside */cursor['source']);

		ctes.push({ type: 'cte', nameToken: nameTok as SqlToken, name, body: cteBody });

		// Skip trailing COMMA between CTEs
		const comma = cursor.peek();
		if (comma?.category === 'sql' && comma.type === 'COMMA') cursor.next();
	}

	// Remaining tokens form the final SELECT.
	const remaining: NinjaSqlToken[] = [];
	while (cursor.has()) remaining.push(cursor.next());
	const finalSelect = segment(remaining, cursor['source']);

	return { type: 'with', ctes, finalSelect };
}

/**
 * Collect all tokens until the matching R_PAREN (consuming the R_PAREN).
 * Handles nested parens.
 */
function collectUntilMatchingParen(cursor: TokenCursor): NinjaSqlToken[] {
	const out: NinjaSqlToken[] = [];
	let depth = 1;
	while (cursor.has() && depth > 0) {
		const tok = cursor.next();
		if (tok.category === 'sql') {
			if (tok.type === 'L_PAREN') depth++;
			else if (tok.type === 'R_PAREN') {
				depth--;
				if (depth === 0) break; // closing paren consumed, not added to out
			}
		}
		out.push(tok);
	}
	return out;
}

// ── Statement ────────────────────────────────────────────────────────────────

function parseStatement(cursor: TokenCursor): StatementSegment {
	const clauses: ClauseSegment[] = [];

	while (cursor.has()) {
		const tok = cursor.peek()!;
		if (cursor.isSetOp(tok)) break;

		if (cursor.isClauseStarter(tok)) {
			clauses.push(parseClause(cursor));
		} else {
			// Token at statement level that isn't a clause starter — e.g. a jinja
			// token wrapping the whole FROM, or a comment. Attach it to the last
			// clause body or skip.
			if (clauses.length > 0) {
				const t = cursor.next();
				clauses[clauses.length - 1].body.push(tokenToSegment(t, cursor));
			} else {
				cursor.next();
			}
		}
	}

	return { type: 'statement', clauses };
}

// ── Clause ───────────────────────────────────────────────────────────────────

function parseClause(cursor: TokenCursor): ClauseSegment {
	const keywords: SqlToken[] = [];
	let keywordText = '';

	// Consume the clause keyword(s). Multi-word: GROUP BY, ORDER BY, LEFT JOIN, etc.
	while (cursor.has()) {
		const tok = cursor.peek()!;
		if (tok.category !== 'sql') break;
		if (!cursor.isClauseStarter(tok as NinjaSqlToken) &&
			tok.type !== 'BY' && tok.type !== 'ALL' && tok.type !== 'DISTINCT' &&
			// Additional join words that follow LEFT/RIGHT/FULL/INNER
			tok.type !== 'JOIN' && tok.type !== 'INNER' && tok.type !== 'OUTER') break;
		if (keywords.length > 0 && cursor.isClauseStarter(tok as NinjaSqlToken) &&
			!JOIN_WORDS.has(tok.type)) break;
		cursor.next();
		keywords.push(tok as SqlToken);
		keywordText += (keywordText ? ' ' : '') + cursor.textOf(tok as NinjaSqlToken);
	}

	// Consume the clause body up to the next clause starter or set-op.
	const body = parseClauseBody(cursor);

	return { type: 'clause', keywords, keywordText, body };
}

function parseClauseBody(cursor: TokenCursor): Segment[] {
	// Collect raw tokens until the next clause starter / set-op / end.
	const raw: NinjaSqlToken[] = [];
	while (cursor.has()) {
		const tok = cursor.peek()!;
		if (cursor.isClauseStarter(tok) || cursor.isSetOp(tok)) break;
		if (tok.category === 'sql' && tok.type === 'WITH') break;
		raw.push(cursor.next());
	}

	// Convert the raw tokens into a comma-separated ListSegment if there are commas.
	return rawToSegments(raw, cursor);
}

// ── Raw → Segment conversion ──────────────────────────────────────────────────

/**
 * Convert a flat raw token slice into segments, recognising commas as list
 * separators and parens as groups. Jinja tokens become JinjaSegments.
 */
function rawToSegments(raw: NinjaSqlToken[], cursor: TokenCursor): Segment[] {
	if (raw.length === 0) return [];

	// Check if there are any commas at depth 0 — if so, build a list.
	let hasTopLevelComma = false;
	let parenDepth = 0;
	for (const t of raw) {
		if (t.category === 'sql') {
			if (t.type === 'L_PAREN') parenDepth++;
			else if (t.type === 'R_PAREN') parenDepth--;
			else if (t.type === 'COMMA' && parenDepth === 0) { hasTopLevelComma = true; break; }
		}
	}

	if (hasTopLevelComma) {
		return [buildListSegment(raw, cursor)];
	}

	// No top-level commas — convert each token to a segment, handling parens.
	return rawTokensToSegments(raw, cursor);
}

function rawTokensToSegments(raw: NinjaSqlToken[], cursor: TokenCursor): Segment[] {
	const out: Segment[] = [];
	let i = 0;
	while (i < raw.length) {
		const tok = raw[i];
		if (tok.category === 'sql' && tok.type === 'L_PAREN') {
			// Collect until matching R_PAREN.
			const parenBody: NinjaSqlToken[] = [];
			let depth = 1;
			i++;
			while (i < raw.length && depth > 0) {
				const inner = raw[i++];
				if (inner.category === 'sql') {
					if (inner.type === 'L_PAREN') depth++;
					else if (inner.type === 'R_PAREN') { depth--; if (depth === 0) break; }
				}
				parenBody.push(inner);
			}
			const parenSegments = rawToSegments(parenBody, cursor);
			const hasList = parenSegments.some(s => s.type === 'list');
			out.push({ type: 'paren', body: parenSegments, hasList });
		} else {
			out.push(tokenToSegment(tok, cursor));
			i++;
		}
	}
	return out;
}

function buildListSegment(raw: NinjaSqlToken[], cursor: TokenCursor): Segment {
	const items: Segment[][] = [];
	let current: NinjaSqlToken[] = [];
	let parenDepth = 0;
	let trailingComma = false;

	for (let i = 0; i < raw.length; i++) {
		const tok = raw[i];
		if (tok.category === 'sql') {
			if (tok.type === 'L_PAREN') parenDepth++;
			else if (tok.type === 'R_PAREN') parenDepth--;
			else if (tok.type === 'COMMA' && parenDepth === 0) {
				items.push(rawTokensToSegments(current, cursor));
				current = [];
				trailingComma = (i === raw.length - 1);
				continue;
			}
		}
		current.push(tok);
		trailingComma = false;
	}
	if (current.length > 0) items.push(rawTokensToSegments(current, cursor));

	return { type: 'list', items, trailingComma };
}

function tokenToSegment(tok: NinjaSqlToken, cursor: TokenCursor): Segment {
	const text = cursor.textOf(tok);
	if (tok.category === 'jinja') {
		return { type: 'jinja', token: tok as JinjaToken, text };
	}
	return { type: 'atom', token: tok as SqlToken, text };
}
