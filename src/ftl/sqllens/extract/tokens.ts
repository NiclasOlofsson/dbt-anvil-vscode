/**
 * Token extraction from the sqllens scope tree.
 *
 * Emits the three DocumentModel token kinds mirroring the legacy sqlglot path:
 *   - `table_ref`  — every FROM/JOIN source (table / CTE-ref / aliased subquery)
 *                    plus one per CTE definition site (`cteDefinition: true`).
 *   - `column_ref` — every column reference at a scope level (`scope.body.columns`),
 *                    with its table qualifier and a `resolvedTableRef` link.
 *   - `column_def` — every aliased/computed projection (the alias declaration site).
 *
 * `scopeId` is a stable numeric id assigned per `Scope` in the walk. Nothing but
 * `resolveTableRefs` reads it; it exists to reproduce the legacy alias→definition
 * matching (a column's qualifier binds to a table_ref alias declared in the SAME
 * scope). See EXTRACTOR-MAP §2.
 */
import type {
	ColumnDefToken,
	ColumnRefToken,
	TableRefToken,
	TokenInfo,
} from '../../../services/parse-service';
import type { ColumnRef, Dialect, PartSpan, Projection, Qualification, QueryBody, ResolvedSource, Token } from '../api';
import { allScopes, asCst, normName, quotedRaw, type CstNode, type SqllensParse } from './spans';

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
 * `keyword`, but legacy sqlglot still treats it as a column/qualifier Identifier.
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
 * (EXTRACTOR-MAP open question 3): TODO(sqllens-partspans).
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
	// the legacy `synthesized` flag has no analog here (EXTRACTOR-MAP §2).
}

function tableRefForSource(src: ResolvedSource, scopeId: number, tokens: Token[], dialect: Dialect): TableRefToken | undefined {
	if (src.kind === 'table' || src.kind === 'cte') {
		const source = src.source;
		const cst = asCst(source.cst);
		const aliasCst = source.aliasCst ? asCst(source.aliasCst) : undefined;
		const canonical = src.kind === 'cte' ? src.ref.def.name : src.name[src.name.length - 1];
		const nameTok = lastNameToken(tokens, cst, aliasCst);

		let tok: TableRefToken;
		if (nameTok) {
			tok = {
				type: 'table_ref',
				name: normName(nameTok.text, dialect),
				line: nameTok.line - 1,
				col: nameTok.column,
				endCol: nameTok.column + nameTok.text.length,
				scopeId,
			};
		} else {
			const s = cst.start;
			tok = {
				type: 'table_ref',
				name: normName(canonical, dialect),
				line: s ? s.line - 1 : 0,
				col: s ? s.column : 0,
				endCol: (s ? s.column : 0) + canonical.length,
				scopeId,
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
			scopeId,
		};
	}

	// lateral / relation (pipe) / pivot / graphtable — no legacy table_ref analog.
	return undefined;
}

function columnDefToken(p: Projection, dialect: Dialect): ColumnDefToken | undefined {
	if (p.isStar || p.name === undefined) return undefined;
	// A bare column projection whose output name echoes the column is a reference,
	// not a declaration — matches sqllens's own symbol emitter (symbols.ts).
	const last = p.expr.kind === 'column' ? p.expr.parts[p.expr.parts.length - 1] : undefined;
	if (last !== undefined && last.toLowerCase() === p.name.toLowerCase()) return undefined;

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

/** 0-based span of a single dotted name-part, computed the way legacy sqlglot
 *  serializes an identifier: the span is anchored at `endCol - unquotedName.length`,
 *  NOT at the raw token start. For an UNQUOTED part this is identity (name width ==
 *  token width). For a QUOTED part legacy's `Column.this` is the quote-stripped name
 *  while its `_col` sits AFTER the closing quote, so the reported span drops the
 *  opening quote (and its first char) and keeps the trailing quote — a legacy quirk
 *  reproduced here so the two paths agree in shadow-diff. `rawText` is the source
 *  token incl. quotes; `column` its 0-based start col; `line1` its 1-based line. */
function namePartPos(rawText: string, column: number, line1: number, dialect: Dialect): {
	name: string; line: number; col: number; endCol: number;
} {
	const name = normName(rawText, dialect);
	const endCol = column + rawText.length;
	return { name, line: line1 - 1, col: endCol - name.length, endCol };
}

function columnRefToken(
	ref: { parts: string[]; partSpans?: PartSpan[]; cst: unknown },
	scopeId: number,
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
		scopeId,
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

function columnRefsOf(body: QueryBody): ReadonlyArray<{ parts: string[]; partSpans?: PartSpan[]; cst: unknown }> {
	if (body.kind === 'select') return body.columns;
	if (body.kind === 'setop') return body.columns;
	return []; // pipe: references live in per-stage child scopes
}

/**
 * Link each qualified column_ref to the FROM/JOIN table_ref its qualifier names,
 * matched within the same scope. Reproduces the legacy `resolveTableRefs` pass:
 * only alias-bearing table_refs are candidates, and the latest alias definition
 * at-or-before the column line wins (falling back to the latest in scope).
 */
function resolveTableRefs(tokens: TokenInfo[], sourceRefs: TableRefToken[]): void {
	const aliased = sourceRefs.filter(t => t.alias !== undefined);
	for (const tok of tokens) {
		if (tok.type !== 'column_ref' || !tok.table) continue;
		const q = tok.table.toLowerCase();
		const scopeRefs = aliased.filter(tr => tr.scopeId === tok.scopeId);

		let best: TableRefToken | undefined;
		for (const tr of scopeRefs) {
			if ((tr.alias ?? '').toLowerCase() !== q) continue;
			if (tr.line > tok.line) continue;
			if (!best || tr.line > best.line) best = tr;
		}
		if (!best) {
			for (const tr of scopeRefs) {
				if ((tr.alias ?? '').toLowerCase() !== q) continue;
				if (!best || tr.line > best.line) best = tr;
			}
		}
		if (best) tok.resolvedTableRef = best;
	}
}

export function extractTokens(parse: SqllensParse, qualification?: Qualification): TokenInfo[] {
	const neutral = parse.tokens;
	const scopes = allScopes(parse.scopes);
	const scopeId = new Map(scopes.map((s, i) => [s, i] as const));

	// Index every lexer token by its start offset so a `partSpans` entry resolves
	// straight to the raw source token (its quoted text feeds normName).
	const byStart = new Map<number, Token>();
	for (const t of neutral) byStart.set(t.start, t);

	const tokens: TokenInfo[] = [];
	const sourceRefs: TableRefToken[] = [];
	// Maps each resolved FROM/JOIN source to its emitted table_ref token, so a bare column's
	// qualify binding (bindingOf → ResolvedSource) can be pointed at the right table_ref.
	const srcToRef = new Map<ResolvedSource, TableRefToken>();

	// Pass 1: declaration sites — CTE defs, FROM/JOIN sources, projection aliases.
	for (const scope of scopes) {
		const id = scopeId.get(scope)!;

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
				scopeId: id,
			});
		}

		for (const src of scope.sources.values()) {
			const tok = tableRefForSource(src, id, neutral, parse.dialect);
			if (tok) {
				tokens.push(tok);
				sourceRefs.push(tok);
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
		const id = scopeId.get(scope)!;
		for (const ref of columnRefsOf(scope.body)) {
			const tok = columnRefToken(ref, id, neutral, byStart, parse.dialect);
			if (!tok) continue;
			// A BARE column (no written qualifier) can't be resolved by resolveTableRefs' alias
			// matching. sqlglot's mutating qualify() rewrote `city` → `addr.city` so the qualifier
			// was present; sqllens is read-only and never rewrites, so consume its column→source
			// binding (Qualification.bindingOf, keyed off ref.parts) to point the token at the
			// source it binds to. Qualified columns stay with resolveTableRefs below.
			if (!tok.table && qualification) {
				const bound = qualification.bindingOf(scope, ref as unknown as ColumnRef)?.source;
				const rt = bound && srcToRef.get(bound);
				if (rt) {
					tok.resolvedTableRef = rt;
					// Reflect the resolved qualifier the way legacy's mutating qualify did (bare
					// `city` gains table `addr`): the DocumentModel's `.table` field is "which table
					// this column belongs to", which providers consume for column navigation.
					tok.table = rt.alias ?? rt.name;
				}
			}
			tokens.push(tok);
		}
	}

	resolveTableRefs(tokens, sourceRefs);
	return tokens;
}
