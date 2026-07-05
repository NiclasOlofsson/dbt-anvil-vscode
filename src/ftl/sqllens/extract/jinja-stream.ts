/**
 * Derive the extension's `JinjaToken[]` from sqllens's unified templated token
 * stream — THE producer of the fine jinja stream (the extension's own scanner
 * is retired; a frozen copy survives as the parity-test oracle in
 * src/test/ftl/reference-jinja-tokenizers.ts).
 *
 * `parseTemplated(rawSql, dialect)` returns ONE source-ordered `Token[]`: SQL
 * tokens on channel 0, and minijinja-island tokens on channel 2 carrying
 * `role === 'minijinja'` (the foreign-vocabulary marker; SQL tokens never use it).
 * Each island token is one minijinja lexer token in DOCUMENT coordinates
 * (`start`/`stop` are inclusive 0-based char offsets). We filter the island
 * tokens, map each onto the `JinjaToken` vocabulary, and set `tagEnd` on every
 * `*_open` from its owning `TagNode.tagSpan.end` (found by binary search — the
 * DESIGNATED mechanism; we never re-scan for `{{`).
 *
 * The output reproduces the retired scanner field-for-field on well-formed
 * dbt SQL (see jinja-stream.test.ts). The two lexers agree because the extension
 * tokenizer already mirrored minijinja's own lexical rules (identifier runs,
 * single/double-quoted strings, `(`/`)`/`,`/`.` punctuation, operator runs), so
 * the type SEQUENCE inside every tag matches — which is what the pattern-matching
 * extractors read. Two deliberate normalisations keep exact parity where the raw
 * island stream would differ:
 *   - minijinja whitespace `JWS` tokens (channel HIDDEN, still stamped channel 2)
 *     are dropped — the extension emits no whitespace tokens.
 *   - comment `COMMENT_TEXT` bodies are whitespace-TRIMMED (start/end/value), and
 *     an all-whitespace body emits no token — matching `tokenizeOpaqueTag`.
 */
import type { JinjaToken, JinjaTokenType } from '../../jinja-tokenizer';
import type { PartSpan, TagNode, Token } from '../api';
import { buildLineStarts, colAtOffset, lineAtOffset } from '../../jinja-spans';

/** minijinja opening-delimiter token names → the `*_open` JinjaToken type. */
const OPEN_TYPES: Record<string, JinjaTokenType> = {
	EXPR_OPEN: 'jinja_expression_open',
	STMT_OPEN: 'jinja_block_open',
	COMMENT_OPEN: 'jinja_comment_open',
};

/** minijinja closing-delimiter token names → the `*_close` JinjaToken type. */
const CLOSE_TYPES: Record<string, JinjaTokenType> = {
	EXPR_CLOSE: 'jinja_expression_close',
	STMT_CLOSE: 'jinja_block_close',
	COMMENT_CLOSE: 'jinja_comment_close',
};

/** The extension's identifier shape (`isIdentStart`/`isIdentPart`): an alpha/`_`-led
 *  run of alphanumerics/`_`. Any minijinja tag-interior token that is not a delimiter,
 *  string, number, or punctuation is classified by this — an identifier-shaped text
 *  (keywords `if`/`set`/…, `true`/`none`, plain identifiers) is a `jinja_identifier`,
 *  anything else (operators `**`/`==`/`|`/`[`/…, stray fallback chars) is a
 *  `jinja_operator`. This mirrors `tokenizeStructuredTag` exactly. */
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const WS_RE = /\s/;

/**
 * Map one minijinja-island token's symbolic name + text to a JinjaToken type, or
 * `null` to DROP it (whitespace). The identifier/operator split is by text shape,
 * mirroring the extension tokenizer's character-class scan.
 */
function mapType(name: string, text: string): JinjaTokenType | null {
	const open = OPEN_TYPES[name];
	if (open) return open;
	const close = CLOSE_TYPES[name];
	if (close) return close;
	switch (name) {
		case 'JWS': return null; // whitespace — the extension emits no whitespace tokens
		case 'STRING': return 'jinja_string';
		case 'FLOAT':
		case 'INT': return 'jinja_number';
		case 'LPAREN': return 'jinja_paren_open';
		case 'RPAREN': return 'jinja_paren_close';
		case 'COMMA': return 'jinja_comma';
		case 'DOT': return 'jinja_dot';
		case 'COMMENT_TEXT':
		case 'COMMENT_ANY': return 'jinja_text';
		default:
			return IDENT_RE.test(text) ? 'jinja_identifier' : 'jinja_operator';
	}
}

/** The `tagSpan.end` of the tag owning `offset` (binary search over source-ordered,
 *  disjoint tag spans), or `undefined` when no tag covers it (never happens for a
 *  channel-2 token — every tag segment carries a TagNode). */
function owningTagEnd(spans: PartSpan[], offset: number): number | undefined {
	let lo = 0;
	let hi = spans.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const s = spans[mid];
		if (offset < s.start) hi = mid - 1;
		else if (offset >= s.end) lo = mid + 1;
		else return s.end;
	}
	return undefined;
}

/**
 * Build `JinjaToken[]` from the unified templated stream. `tokens` is
 * `parseTemplated(...).tokens`, `tags` is `parseTemplated(...).tags`, `rawSql` is
 * the original document the spans index into (offset -> line/col via the SAME
 * helpers `tokenizeJinja` uses, so positions are byte-identical).
 */
export function jinjaTokensFromStream(tokens: Token[], tags: TagNode[], rawSql: string): JinjaToken[] {
	const lineStarts = buildLineStarts(rawSql);
	const spans = tags.map(t => t.tagSpan);
	const out: JinjaToken[] = [];

	for (const tok of tokens) {
		if (tok.role !== 'minijinja') continue; // SQL tokens (channel 0) are not jinja

		const type = mapType(tok.name, tok.text);
		if (type === null) continue; // whitespace

		let start = tok.start;
		let end = tok.stop + 1; // sqllens stop is INCLUSIVE; JinjaToken end is EXCLUSIVE
		let value: string;

		if (type === 'jinja_string') {
			// Quotes excluded from the value; start/end still cover the quoted span.
			value = tok.text.length >= 2 ? tok.text.slice(1, -1) : tok.text;
		} else if (type === 'jinja_text') {
			// Comment body — whitespace-trim both ends (start/end/value) like
			// tokenizeOpaqueTag; an all-whitespace body emits nothing.
			const t = tok.text;
			let a = 0;
			let b = t.length;
			while (a < b && WS_RE.test(t[a])) a++;
			while (b > a && WS_RE.test(t[b - 1])) b--;
			if (b <= a) continue;
			start = tok.start + a;
			end = tok.start + b;
			value = t.slice(a, b);
		} else {
			value = tok.text;
		}

		// Coalesce a run of ADJACENT operator tokens into ONE, mirroring
		// tokenizeStructuredTag's operator scan: the extension reads a maximal run of
		// operator-class chars as a single `jinja_operator`, so the minijinja lexer's
		// finer split (e.g. `=[` -> ASSIGN + LBRACK, or `][` -> RBRACK + LBRACK) must be
		// re-fused. Only CONTIGUOUS operators fuse (a skipped whitespace token leaves a
		// gap, which the extension also treats as a run boundary); parens/comma/dot are
		// their own types and naturally break the run.
		const prev = out[out.length - 1];
		if (type === 'jinja_operator' && prev?.type === 'jinja_operator' && prev.end === start) {
			prev.end = end;
			prev.value += value;
			continue;
		}

		const jt: JinjaToken = {
			type,
			start,
			end,
			line: lineAtOffset(start, lineStarts),
			col: colAtOffset(start, lineStarts),
			value,
		};
		if (type === 'jinja_expression_open' || type === 'jinja_block_open' || type === 'jinja_comment_open') {
			// tagEnd is REQUIRED on every *_open = the owning tag's exclusive end.
			jt.tagEnd = owningTagEnd(spans, start);
		}
		out.push(jt);
	}

	return out;
}
