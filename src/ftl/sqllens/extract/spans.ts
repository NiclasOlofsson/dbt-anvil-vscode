/**
 * Position + CST helpers shared by the sqllens-native extractors.
 *
 * sqllens carries exact spans on antlr Token objects hung off every IR node's
 * `cst` back-reference (a `ParserRuleContext`): `cst.start` / `cst.stop` are the
 * first/last lexer tokens of the node. antlr positions are 1-based line, 0-based
 * column; the extension's DocumentModel is uniformly 0-based line, 0-based
 * inclusive start col, 0-based exclusive end col — so every conversion here is
 * `line - 1` and `endCol = column + text.length`.
 *
 * We deliberately model the antlr token/context structurally (not by importing
 * antlr4ng, which the extension does not depend on directly) — the two fields we
 * read (`start`/`stop` tokens, each with `start`/`stop`/`line`/`column`/`text`)
 * are stable and this keeps the boundary narrow.
 */
import type { Dialect, QueryBody, QueryExpr, Scope, ScopeTree, SelectExpr, SyntaxDiagnostic, Token } from '../api';

/** One antlr lexer token, as much of it as the extractors read. */
export interface AntlrToken {
	/** 0-based inclusive char offset of the first char. */
	start: number;
	/** 0-based inclusive char offset of the last char. */
	stop: number;
	/** 1-based line. */
	line: number;
	/** 0-based column. */
	column: number;
	text: string | null;
}

/** The bits of a `ParserRuleContext` the extractors read. */
export interface CstNode {
	start: AntlrToken | null;
	stop: AntlrToken | null;
}

/** Narrow an IR node's `cst` back-reference to the structural shape we read. */
export function asCst(cst: unknown): CstNode {
	return cst as CstNode;
}

export interface Pos {
	/** 0-based line. */
	line: number;
	/** 0-based inclusive start column. */
	col: number;
	/** 0-based exclusive end column. */
	endCol: number;
}

/** 0-based span of a single antlr token. */
export function tokenPos(t: AntlrToken): Pos {
	return { line: t.line - 1, col: t.column, endCol: t.column + (t.text?.length ?? 0) };
}

/** How a dialect folds identifier case, split by whether the identifier is quoted. */
type Casing = 'lower' | 'upper' | 'preserve';
interface NormPolicy {
	/** Casing applied to an UNQUOTED identifier. */
	unquoted: Casing;
	/** Casing applied to a QUOTED identifier (after its delimiters are stripped). */
	quoted: Casing;
}

/**
 * Per-dialect identifier-normalization policy. Each dialect has a NORMALIZATION_STRATEGY
 * that determines how identifiers are cased (uppercase, lowercase, or preserved).
 * These policies are the extension's identifier-casing behavior (snowflake `Foo_Bar`→`FOO_BAR`,
 * `"Out_Col"`→`Out_Col`; tsql `[Mixed]`→`mixed`; postgres unquoted lowered / quoted preserved).
 *
 * Strategy → policy:
 *   - CASE_INSENSITIVE → both lowercased (quoted included): databricks, tsql,
 *     bigquery, redshift, duckdb, trino.
 *   - UPPERCASE → unquoted uppercased, quoted preserved: snowflake.
 *   - LOWERCASE → unquoted lowercased, quoted preserved: postgres.
 */
const NORM_POLICY: Record<Dialect, NormPolicy> = {
	databricks: { unquoted: 'lower', quoted: 'lower' },
	tsql: { unquoted: 'lower', quoted: 'lower' },
	bigquery: { unquoted: 'lower', quoted: 'lower' },
	redshift: { unquoted: 'lower', quoted: 'lower' },
	duckdb: { unquoted: 'lower', quoted: 'lower' },
	trino: { unquoted: 'lower', quoted: 'lower' },
	snowflake: { unquoted: 'upper', quoted: 'preserve' },
	postgres: { unquoted: 'lower', quoted: 'preserve' },
};

function applyCasing(s: string, c: Casing): string {
	if (c === 'lower') return s.toLowerCase();
	if (c === 'upper') return s.toUpperCase();
	return s;
}

/**
 * Normalize a SQL identifier's NAME according to the dialect's rules (see `NORM_POLICY`).
 * The surrounding quotes are always stripped (`` `Mixed` `` / `"Mixed"` / `[Mixed]` → `Mixed`);
 * the case fold then depends on the dialect and on whether the identifier was quoted:
 *   - databricks/tsql/bigquery/redshift/duckdb/trino: everything lowercased —
 *     `Upper_Col` → `upper_col`, `` `Mixed` `` → `mixed` (case-insensitive engines).
 *   - snowflake: unquoted uppercased (`Foo_Bar` → `FOO_BAR`), quoted preserved
 *     (`"Out_Col"` → `Out_Col`).
 *   - postgres: unquoted lowercased, quoted preserved (`"Mixed"` → `Mixed`).
 * This is a NAME-only transform — source spans (col/endCol) are computed from the
 * raw token text and are never touched by it.
 */
export function normName(raw: string, dialect: Dialect): string {
	const policy = NORM_POLICY[dialect];
	const c = raw[0];
	if (c === '`' || c === '"' || c === '[') {
		const close = c === '[' ? ']' : c;
		const end = raw.length > 1 && raw[raw.length - 1] === close ? raw.length - 1 : raw.length;
		return applyCasing(raw.slice(1, end), policy.quoted);
	}
	return applyCasing(raw, policy.unquoted);
}

/**
 * Recover the raw, delimiter-carrying form of an identifier for `normName`.
 *
 * sqllens's IR strips a DOUBLE-QUOTED identifier's delimiters from its `.name` /
 * `.parts` strings (it keeps backtick/bracket, but not `"…"`), so a `"Mixed"`
 * reaches `normName` looking unquoted — harmless for the case-INSENSITIVE dialects
 * (they fold quoted and unquoted the same way) but wrong for snowflake (would
 * uppercase a name meant to be preserved) and postgres (would lowercase it). The
 * lexer token always carries the delimiters, so where the IR string is fed to
 * `normName` we consult the identifier's source token: when it is a quoted form
 * whose stripped content matches the IR name (case-insensitively), use the token;
 * otherwise the IR string already carries whatever delimiters exist, so trust it.
 */
export function quotedRaw(irName: string, rawTok: string | undefined): string {
	if (!rawTok || rawTok.length < 2) return irName;
	const c = rawTok[0];
	if (c !== '"' && c !== '`' && c !== '[') return irName;
	const close = c === '[' ? ']' : c;
	if (rawTok[rawTok.length - 1] !== close) return irName;
	const inner = rawTok.slice(1, -1);
	return inner.toLowerCase() === irName.toLowerCase() ? rawTok : irName;
}

/**
 * The neutral parse result the extractors consume — the tiers of sqllens's
 * `parse()` + `resolveScopes()` that the DocumentModel is built from. We stop
 * short of the full `analyze()` (qualify / infer / lineage / symbols) because
 * the structural model is derivable from scopes + IR + tokens alone.
 */
export interface SqllensParse {
	ast: QueryExpr;
	/** The dialect the parse ran under — selects the identifier-normalization policy (`normName`). */
	dialect: Dialect;
	/** Lexer + parser syntax-error count (a valid parse is still returned). */
	errors: number;
	/** Positioned syntax diagnostics — the source of `syntax_error` warnings. */
	diagnostics: SyntaxDiagnostic[];
	scopes: ScopeTree;
	/** Every lexer token (trivia included, EOF excluded), with exact char spans. */
	tokens: Token[];
}

/** Every scope in the tree, root first, depth-first over `children`. */
export function allScopes(tree: ScopeTree): Scope[] {
	const out: Scope[] = [];
	const visit = (s: Scope): void => {
		out.push(s);
		for (const c of s.children) visit(c);
	};
	visit(tree.root);
	return out;
}

/**
 * The leftmost `SelectExpr` reachable from a query body — a set operation's
 * output columns come from its left branch, so this unwraps `UNION`/`EXCEPT`/
 * `INTERSECT` to the branch that names the columns. `undefined` for a pipe body
 * (its output columns live in the per-stage scopes, not a select projection list).
 */
export function leftSelect(body: QueryBody): SelectExpr | undefined {
	if (body.kind === 'select') return body;
	if (body.kind === 'setop') return leftSelect(body.left);
	return undefined;
}

/**
 * The scope whose `body` is `leftSelect(scope.body)` — the setop analog of `leftSelect`
 * for scopes. A set operation's output columns (and its FROM sources, for star
 * expansion) live on the left branch's scope, so this unwraps `branches.left` in
 * lockstep with `leftSelect` unwrapping `body.left`. A non-setop scope is returned
 * unchanged (a pipe scope has no left-select projections to expand).
 */
export function leftSelectScope(scope: Scope): Scope {
	return scope.branches ? leftSelectScope(scope.branches.left) : scope;
}
