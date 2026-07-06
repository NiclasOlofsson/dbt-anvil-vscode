/**
 * Token extraction from the sqllens scope tree.
 *
 * Emits the three DocumentModel token kinds:
 *   - `table_ref`  — every FROM/JOIN source (table / CTE-ref / aliased subquery)
 *                    plus one per CTE definition site (`cteDefinition: true`).
 *   - `column_ref` — every column reference at a scope level (`scope.body.columns`),
 *                    with its table qualifier and a `resolvedTableRef` link.
 *   - `column_def` — every aliased/computed projection (the alias declaration site).
 *
 * A column_ref's `resolvedTableRef` (which FROM/JOIN source its qualifier — written
 * or bare — names) comes from `Qualification.bindingOf`, sqllens's own scope-chain
 * walk (real correlation support, not a same-scope heuristic): see the `bindingOf`
 * call in Pass 2 below.
 */
import type {
	RefInfo,
	SourceInfo,
	ColumnDefToken,
	ColumnRefToken,
	TableRefToken,
	TokenInfo,
} from '../../../services/parse-service';
import type { Dialect, PartSpan, Projection, Qualification, ResolvedSource, TableSource, Token } from '../api';
import type { StarExpander } from './star-expand';
import { allScopes, asCst, columnRefsOf, normName, quotedRaw, type CstNode, type SqllensParse } from './spans';

/** Identifier-role tokens fully inside a `[lo, hi]` char range, in source order. */
function identTokensInRange(tokens: Token[], lo: number, hi: number): Token[] {
	const out: Token[] = [];
	for (const t of tokens) {
		if (t.role !== 'identifier') continue;
		if (t.start >= lo && t.stop <= hi) out.push(t);
	}
	return out;
}

/**
 * The dotted name-part tokens inside a `[lo, hi]` range, in source order. Unlike
 * `identTokensInRange`, this also accepts `keyword`-role tokens: sqllens tags an
 * identifier that collides with a reserved word (`name`, `x`, …) as role
 * `keyword`, but the legacy parser still treated it as a column/qualifier Identifier.
 * A column reference's CST span is strictly `part (DOT part)*`, so every
 * identifier-or-keyword token in the span is a name part (no `AS`, no functions).
 */
function namePartTokensInRange(tokens: Token[], lo: number, hi: number): Token[] {
	const out: Token[] = [];
	for (const t of tokens) {
		if (t.role !== 'identifier' && t.role !== 'keyword') continue;
		if (t.start >= lo && t.stop <= hi) out.push(t);
	}
	return out;
}

/**
 * The last name-part token of a table reference — the token the extension points
 * a `table_ref` at. Restricting the scan to the range before the alias keeps a
 * multipart `catalog.schema.tbl u` reporting `tbl` (not the alias `u`). This is
 * the token-stream interim for the unconfirmed per-part table-name span
 * (upstream channel item identifier-boundary-contract): TODO(sqllens-partspans).
 */
function lastNameToken(tokens: Token[], cst: CstNode, aliasCst?: CstNode): Token | undefined {
	const start = cst.start;
	if (!start) return undefined;
	const nameHi = aliasCst?.start ? aliasCst.start.start - 1 : (cst.stop ? cst.stop.stop : start.stop);
	const idents = identTokensInRange(tokens, start.start, nameHi);
	return idents.length ? idents[idents.length - 1] : undefined;
}

function addAlias(tok: TableRefToken, alias: string | undefined, aliasCst?: CstNode): void {
	if (!alias) return;
	tok.alias = alias;
	const s = aliasCst?.start;
	if (s) {
		tok.aliasLine = s.line - 1;
		tok.aliasCol = s.column;
		tok.aliasEndCol = s.column + alias.length;
	}
	// Note: sqllens IR is frozen, so an alias is never qualify()-synthesised —
	// the legacy `synthesized` flag has no analog here.
}

function tableRefForSource(src: ResolvedSource, tokens: Token[], dialect: Dialect): TableRefToken | undefined {
	if (src.kind === 'table' || src.kind === 'cte') {
		const source = src.source;
		const cst = asCst(source.cst);
		const aliasCst = source.aliasCst ? asCst(source.aliasCst) : undefined;
		const canonical = src.kind === 'cte' ? src.ref.def.name : src.name[src.name.length - 1];
		const nameTok = lastNameToken(tokens, cst, aliasCst);
		// Mirrors sqllens's own sourceKey rule (scope.ts:587): a physical table's last
		// name part folds as 'table' (bigquery preserves its case); a CTE reference
		// folds as 'other', same as any other identifier.
		const kind = src.kind === 'table' ? 'table' as const : 'other' as const;

		// R3: a templated relation (`{{ ref('x') }}` in a FROM/JOIN slot) parses over a
		// length-preserving placeholder, so its physical name token is filler (`jjj…`). The
		// tag-applied ast sets the SOURCE name to the real model — prefer `canonical` over
		// the placeholder token text there. No-op on plain SQL (no `template` marker; the
		// token text IS the real name).
		const template = src.kind === 'table' ? (src.source as TableSource).template : undefined;
		// endCol widens to the whole `{{ … }}` from `template.span` (hover/diagnostic
		// ranges cover the tag incl. closing braces) — for ref/source tags ONLY, the
		// exact set the old jinja-token-enrichment stitch widened. Opaque macro/expr
		// sources keep the name-width span the rules always saw for them.
		const tagWide = template && (template.kind === 'ref' || template.kind === 'source')
			? template.span.endColumn
			: undefined;

		let tok: TableRefToken;
		if (nameTok) {
			const display = template ? canonical : nameTok.text;
			tok = {
				type: 'table_ref',
				name: normName(display, dialect, kind),
				line: nameTok.line - 1,
				col: nameTok.column,
				endCol: tagWide ?? nameTok.column + display.length,
			};
		} else {
			const s = cst.start;
			tok = {
				type: 'table_ref',
				name: normName(canonical, dialect, kind),
				line: s ? s.line - 1 : 0,
				col: s ? s.column : 0,
				endCol: tagWide ?? (s ? s.column : 0) + canonical.length,
			};
		}
		addAlias(tok, source.alias, aliasCst);
		return tok;
	}

	if (src.kind === 'subquery') {
		const alias = src.source.alias;
		const aliasCst = src.source.aliasCst ? asCst(src.source.aliasCst) : undefined;
		const s = aliasCst?.start;
		if (!alias || !s) return undefined;
		// The subquery alias is both the token name and its alias — no underlying
		// table name is being renamed, so self-alias checks must not fire.
		return {
			type: 'table_ref',
			name: alias,
			alias,
			line: s.line - 1,
			col: s.column,
			endCol: s.column + alias.length,
			aliasLine: s.line - 1,
			aliasCol: s.column,
			aliasEndCol: s.column + alias.length,
			isSubquery: true,
		};
	}

	// lateral / relation (pipe) / pivot / graphtable — no legacy table_ref analog.
	return undefined;
}

function columnDefToken(p: Projection, dialect: Dialect): ColumnDefToken | undefined {
	if (p.isStar || p.name === undefined) return undefined;
	// A bare column projection whose output name echoes the column is a reference,
	// not a declaration — matches sqllens's own symbol emitter (symbols.ts). But a
	// SELF-NAMED alias (`team as team`, `b."Date" as "date"`) is a real declaration
	// site the user wrote: the IR normalizes its `alias` away, yet `aliasCst` still
	// carries the alias token — emit the def there (legacy did; hover/rename on the
	// alias identifier depends on it).
	const last = p.expr.kind === 'column' ? p.expr.parts[p.expr.parts.length - 1] : undefined;
	if (last !== undefined && last.toLowerCase() === p.name.toLowerCase() && p.aliasCst === undefined) return undefined;

	// ITEM 5 (sqllens e6078d7): `Projection.aliasCst` is the alias identifier's own CST —
	// present ⇔ an explicit alias (delimiters in, AS out). The old cst.stop heuristic
	// misread trailing comments and parenthesized `(a+b) AS x`; it remains only as the
	// fallback for a named non-echo projection without aliasCst (not seen in practice).
	const a = p.aliasCst ? asCst(p.aliasCst) : asCst(p.cst);
	const s = a.stop ?? a.start;
	if (!s) return undefined;
	return {
		type: 'column_def',
		name: normName(quotedRaw(p.name, s.text ?? undefined), dialect),
		line: s.line - 1,
		col: s.column,
		endCol: s.column + (s.text?.length ?? p.name.length),
	};
}

/** 0-based span of a single dotted name-part. The span covers the WHOLE raw
 *  source token, delimiters included: a quoted part (`` `My Col` ``, `"My Col"`,
 *  `[My Col]`) spans from its opening delimiter through its closing one. For an
 *  unquoted part this is identity (name width == token width). The NAME is
 *  dialect-normalized by `normName`; normalization never affects the span.
 *  `rawText` is the source token incl. quotes; `column` its 0-based start col;
 *  `line1` its 1-based line. */
function namePartPos(rawText: string, column: number, line1: number, dialect: Dialect): {
	name: string; line: number; col: number; endCol: number;
} {
	const name = normName(rawText, dialect);
	return { name, line: line1 - 1, col: column, endCol: column + rawText.length };
}

function columnRefToken(
	ref: { parts: string[]; partSpans?: PartSpan[]; cst: unknown },
	tokens: Token[],
	byStart: Map<number, Token>,
	dialect: Dialect,
): ColumnRefToken | undefined {
	const c = asCst(ref.cst);
	const start = c.start;
	const stop = c.stop;
	if (!start || !stop) return undefined;

	// The IR column ref's LAST part is the column name; the part directly BEFORE it
	// is the table qualifier (for a 3-part `db.schema.col` the qualifier is `schema`,
	// matching legacy's `Column.table` child).
	//
	// Prefer `partSpans` when the IR carries them: they are per-part source spans read
	// straight off each part's own token, so no token-stream guessing is needed. The
	// contract is ALL-OR-NOTHING — present ⇒ same length as `parts`, 1:1 aligned — so a
	// present array is safe to index positionally. When ABSENT (a synthesized part: a
	// dotted getText() split, a `$n` positional, a dot-fused path) fall back to scanning
	// the dotted name-part tokens inside the ref's char range. TODO(sqllens-partspans)
	// is retired for the present case; the scan stays as the documented fallback.
	const spans = ref.partSpans;
	const usePartSpans = spans !== undefined && spans.length === ref.parts.length && spans.length >= 1;

	let namePos: { name: string; line: number; col: number; endCol: number };
	let qualPos: { name: string; line: number; col: number; endCol: number } | undefined;
	let qualName: string | undefined; // the qualifier name even when its span is unknown

	if (usePartSpans) {
		const nameSpan = spans[spans.length - 1];
		const nameTok = byStart.get(nameSpan.start);
		namePos = namePartPos(nameTok?.text ?? ref.parts[ref.parts.length - 1], nameSpan.column, nameSpan.line, dialect);
		if (ref.parts.length >= 2) {
			const qSpan = spans[spans.length - 2];
			const qTok = byStart.get(qSpan.start);
			qualPos = namePartPos(qTok?.text ?? ref.parts[ref.parts.length - 2], qSpan.column, qSpan.line, dialect);
			qualName = qualPos.name;
		}
	} else {
		const parts = namePartTokensInRange(tokens, start.start, stop.stop);
		const nameTok = parts.length ? parts[parts.length - 1] : undefined;
		namePos = nameTok
			? namePartPos(nameTok.text, nameTok.column, nameTok.line, dialect)
			: { name: normName(ref.parts[ref.parts.length - 1], dialect), line: stop.line - 1, col: stop.column, endCol: stop.column + normName(ref.parts[ref.parts.length - 1], dialect).length };
		if (ref.parts.length >= 2) {
			const qTok = parts.length >= 2 ? parts[parts.length - 2] : undefined;
			// Legacy still records `table` from the IR part even with no source span.
			qualName = normName(qTok ? qTok.text : ref.parts[ref.parts.length - 2], dialect);
			if (qTok) qualPos = namePartPos(qTok.text, qTok.column, qTok.line, dialect);
		}
	}

	const tok: ColumnRefToken = {
		type: 'column_ref',
		name: namePos.name,
		line: namePos.line,
		col: namePos.col,
		endCol: namePos.endCol,
	};

	if (ref.parts.length >= 2 && qualName !== undefined) {
		tok.table = qualName;
		if (qualPos) {
			tok.tableLine = qualPos.line;
			tok.tableCol = qualPos.col;
			tok.tableEndCol = qualPos.endCol;
		}
	}
	return tok;
}

export function extractTokens(parse: SqllensParse, qualification?: Qualification, starExpander?: StarExpander): TokenInfo[] {
	const neutral = parse.tokens;
	const scopes = allScopes(parse.scopes);

	// Index every lexer token by its start offset so a `partSpans` entry resolves
	// straight to the raw source token (its quoted text feeds normName).
	const byStart = new Map<number, Token>();
	for (const t of neutral) byStart.set(t.start, t);

	const tokens: TokenInfo[] = [];
	// Maps each resolved FROM/JOIN source to its emitted table_ref token, so a column's
	// qualify binding (bindingOf → ResolvedSource) can be pointed at the right table_ref.
	const srcToRef = new Map<ResolvedSource, TableRefToken>();

	// Pass 1: declaration sites — CTE defs, FROM/JOIN sources, projection aliases.
	for (const scope of scopes) {
		for (const [, cteRef] of scope.ctes) {
			const s = asCst(cteRef.def.cst).start;
			if (!s) continue;
			const rawName = cteRef.def.name;
			const name = normName(quotedRaw(rawName, s.text ?? undefined), parse.dialect);
			tokens.push({
				type: 'table_ref',
				name,
				line: s.line - 1,
				col: s.column,
				endCol: s.column + rawName.length,
				cteDefinition: true,
			});
		}

		for (const src of scope.sources.values()) {
			const tok = tableRefForSource(src, neutral, parse.dialect);
			if (tok) {
				tokens.push(tok);
				srcToRef.set(src, tok);
			}
		}

		if (scope.body.kind === 'select') {
			for (const p of scope.body.projections) {
				const def = columnDefToken(p, parse.dialect);
				if (def) tokens.push(def);
			}
		}
	}

	// Pass 2: column references (need the full table_ref set for resolution).
	for (const scope of scopes) {
		for (const ref of columnRefsOf(scope.body)) {
			const tok = columnRefToken(ref, neutral, byStart, parse.dialect);
			if (!tok) continue;
			// sqllens is read-only and never rewrites a column's qualifier, so a BARE column
			// (`city`) and a QUALIFIED one (`o.order_id`) resolve to their FROM/JOIN source the
			// same way: Qualification.bindingOf — real scope-chain walking with correlation
			// support, not a qualifier-string/same-scope heuristic. `.table` is upgraded to the
			// resolved source's canonical alias/name when bindingOf succeeds; the qualifier text
			// columnRefToken already carries stays as the fallback when it doesn't (e.g. a typo,
			// or a reference bindingOf can't resolve from here).
			if (qualification) {
				const bound = qualification.bindingOf(scope, ref)?.source;
				const rt = bound && srcToRef.get(bound);
				if (rt) {
					tok.resolvedTableRef = rt;
					tok.table = rt.alias ?? rt.name;
				}
			}
			tokens.push(tok);
		}
	}

	// Pass 3: synthetic column_refs for `SELECT *`-expanded columns. The legacy parser
	// would rewrite each star into explicit Column nodes, so the token stream carried
	// one column_ref per expanded column with `resolvedTableRef` pointing at the
	// source it came from — consumers (the unused-columns ninja rule's
	// buildReferencedColumnsMap) key on name + resolvedTableRef to see a CTE's columns
	// as "referenced" through a downstream `SELECT *`. sqllens never rewrites, so we
	// expansion is re-emitted here from the star expander (qualify columnsOf data).
	// Spans are deliberately ZERO-WIDTH at the star's start token (legacy's synthetic
	// tokens had broken positions; nothing keys on them): `col === endCol` never
	// matches position hit-testing (`col < endCol`), so hover/definition on the `*`
	// stay unaffected, and no negative range can be produced. Appended AFTER the real
	// refs so first-match-by-name consumers keep finding user-written tokens.
	if (starExpander) {
		for (const scope of scopes) {
			if (scope.body.kind !== 'select') continue;
			for (const p of scope.body.projections) {
				if (p.expr.kind !== 'star') continue;
				const expanded = starExpander.expandStar(scope, p);
				if (!expanded) continue; // unresolvable star — leave unexpanded, like legacy
				const anchor = asCst(p.cst).start;
				for (const ec of expanded) {
					// `ec.table` is the scope-source key the column came from (FROM order,
					// as the expander walks `scope.sources`); map it back to the emitted
					// table_ref through the same srcToRef built in Pass 1.
					const src = ec.table !== undefined ? scope.sources.get(ec.table) : undefined;
					const rt = src ? srcToRef.get(src) : undefined;
					if (!rt) continue; // source with no table_ref analog (lateral/pivot/…)
					tokens.push({
						type: 'column_ref',
						name: normName(ec.name, parse.dialect),
						line: anchor ? anchor.line - 1 : rt.line,
						col: anchor ? anchor.column : rt.col,
						endCol: anchor ? anchor.column : rt.col,
						// The qualifier legacy's qualify_columns would have prepended —
						// keeps ambiguity/alias rules seeing these as qualified refs.
						table: rt.alias ?? rt.name,
						resolvedTableRef: rt,
					});
				}
			}
		}
	}

	return tokens;
}

/**
 * Back-fill `alias` on ref/source infos from the matching template-marked
 * `table_ref` token — the tag-AST knows the tag but never sees SQL aliases
 * (`{{ ref('x') }} co`), the token side does. The span half of the old
 * jinja-token-enrichment stitch is gone (tokens are born tag-wide from
 * `template.span` above); this is the surviving alias half, same match keys.
 */
export function backfillTagAliases(tokens: TokenInfo[], refs: RefInfo[], sources: SourceInfo[]): void {
	for (const ref of refs) {
		const tok = tokens.find((t): t is TableRefToken =>
			t.type === 'table_ref' && t.name === ref.model && t.line === ref.line && t.col === ref.jinjaCol,
		);
		if (tok?.alias && tok.alias !== ref.model) ref.alias = tok.alias;
	}
	for (const src of sources) {
		const tok = tokens.find((t): t is TableRefToken =>
			t.type === 'table_ref' && t.name === src.tableName && t.line === src.line && t.col === src.jinjaCol,
		);
		if (tok?.alias && tok.alias !== src.tableName) src.alias = tok.alias;
	}
}
