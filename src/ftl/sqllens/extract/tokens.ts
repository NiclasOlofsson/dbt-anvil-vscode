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
import type { Projection, QueryBody, ResolvedSource, Token } from '../api';
import { allScopes, asCst, normName, type CstNode, type SqllensParse } from './spans';

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

function tableRefForSource(src: ResolvedSource, scopeId: number, tokens: Token[]): TableRefToken | undefined {
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
				name: normName(nameTok.text),
				line: nameTok.line - 1,
				col: nameTok.column,
				endCol: nameTok.column + nameTok.text.length,
				scopeId,
			};
		} else {
			const s = cst.start;
			tok = {
				type: 'table_ref',
				name: normName(canonical),
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

function columnDefToken(p: Projection): ColumnDefToken | undefined {
	if (p.isStar || p.name === undefined) return undefined;
	// A bare column projection whose output name echoes the column is a reference,
	// not a declaration — matches sqllens's own symbol emitter (symbols.ts).
	const last = p.expr.kind === 'column' ? p.expr.parts[p.expr.parts.length - 1] : undefined;
	if (last !== undefined && last.toLowerCase() === p.name.toLowerCase()) return undefined;

	// TODO(sqllens-aliascst): no dedicated alias-identifier CST node exists; the
	// projection's last token (cst.stop) IS the alias when written `expr AS name`.
	const c = asCst(p.cst);
	const s = c.stop ?? c.start;
	if (!s) return undefined;
	return {
		type: 'column_def',
		name: normName(p.name),
		line: s.line - 1,
		col: s.column,
		endCol: s.column + (s.text?.length ?? p.name.length),
	};
}

function columnRefToken(
	ref: { parts: string[]; cst: unknown },
	scopeId: number,
	tokens: Token[],
): ColumnRefToken | undefined {
	const c = asCst(ref.cst);
	const start = c.start;
	const stop = c.stop;
	if (!start || !stop) return undefined;

	// sqllens carries one CST span for the whole dotted reference; the column-name
	// and qualifier sub-spans are derived by scanning the dotted name-part tokens
	// inside the ref's char range. The LAST part is the column name; the part
	// directly BEFORE it is the table qualifier (for a 3-part `db.schema.col` the
	// qualifier is `schema`, matching legacy's `Column.table` child).
	const parts = namePartTokensInRange(tokens, start.start, stop.stop);
	const nameTok = parts.length ? parts[parts.length - 1] : undefined;
	const rawName = nameTok ? nameTok.text : ref.parts[ref.parts.length - 1];
	const name = normName(rawName);
	const line = nameTok ? nameTok.line - 1 : stop.line - 1;
	const col = nameTok ? nameTok.column : stop.column;
	const endCol = col + (nameTok ? nameTok.text.length : name.length);

	const tok: ColumnRefToken = { type: 'column_ref', name, line, col, endCol, scopeId };

	if (ref.parts.length >= 2) {
		const qTok = parts.length >= 2 ? parts[parts.length - 2] : undefined;
		tok.table = normName(qTok ? qTok.text : ref.parts[ref.parts.length - 2]);
		if (qTok) {
			tok.tableLine = qTok.line - 1;
			tok.tableCol = qTok.column;
			tok.tableEndCol = qTok.column + qTok.text.length;
		}
	}
	return tok;
}

function columnRefsOf(body: QueryBody): ReadonlyArray<{ parts: string[]; cst: unknown }> {
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

export function extractTokens(parse: SqllensParse): TokenInfo[] {
	const neutral = parse.tokens;
	const scopes = allScopes(parse.scopes);
	const scopeId = new Map(scopes.map((s, i) => [s, i] as const));

	const tokens: TokenInfo[] = [];
	const sourceRefs: TableRefToken[] = [];

	// Pass 1: declaration sites — CTE defs, FROM/JOIN sources, projection aliases.
	for (const scope of scopes) {
		const id = scopeId.get(scope)!;

		for (const [, cteRef] of scope.ctes) {
			const s = asCst(cteRef.def.cst).start;
			if (!s) continue;
			const rawName = cteRef.def.name;
			const name = normName(rawName);
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
			const tok = tableRefForSource(src, id, neutral);
			if (tok) {
				tokens.push(tok);
				sourceRefs.push(tok);
			}
		}

		if (scope.body.kind === 'select') {
			for (const p of scope.body.projections) {
				const def = columnDefToken(p);
				if (def) tokens.push(def);
			}
		}
	}

	// Pass 2: column references (need the full table_ref set for resolution).
	for (const scope of scopes) {
		const id = scopeId.get(scope)!;
		for (const ref of columnRefsOf(scope.body)) {
			const tok = columnRefToken(ref, id, neutral);
			if (tok) tokens.push(tok);
		}
	}

	resolveTableRefs(tokens, sourceRefs);
	return tokens;
}
