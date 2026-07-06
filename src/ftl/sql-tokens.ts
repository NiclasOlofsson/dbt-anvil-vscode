/**
 * Parser-neutral token and dialect-symbol contracts. This is the vocabulary
 * shared by the parser (which produces it) and the ninja rules, reflow
 * printer, and debug-symbol emitters (which consume it).
 */

/**
 * One SQL token in the document's token stream. Token `type` names are the
 * extension's own vocabulary (see `src/ftl/sqllens/token-mapper.ts` for the
 * full set) — uppercase labels like 'SELECT', 'VAR', 'NUMBER', 'L_PAREN'.
 */
export interface SqlToken {
	/** Token type name, e.g. 'SELECT', 'FROM', 'VAR', 'NUMBER' */
	type: string;
	/** 0-based char offset of first character */
	start: number;
	/** 0-based char offset of last character (inclusive) */
	end: number;
	/** 0-based line number */
	line: number;
	/** 1-based end column (= 0-based exclusive end col) */
	col: number;
	/**
	 * Comment spans attached to this token. Comments never appear as
	 * standalone tokens in the stream: a trailing comment (same line) rides
	 * the preceding token; a leading comment rides the succeeding token.
	 * `start` is inclusive, `end` is exclusive (the char after the comment).
	 */
	comments?: Array<{ start: number; end: number; text: string }>;
}

/** Authoritative symbol lists for a specific SQL dialect. */
export interface DialectSymbols {
	/** Lowercase SQL function names (e.g. 'count', 'regexp_extract'). */
	readonly functions: ReadonlySet<string>;
	/** Lowercase token-type names that represent SQL keywords (e.g. 'select', 'qualify'). */
	readonly keywordTokenTypes: ReadonlySet<string>;
	/** Lowercase data type names (e.g. 'bigint', 'timestamp_ltz'). */
	readonly types: ReadonlySet<string>;
}

export type { JinjaToken, JinjaTokenType } from './jinja-tokenizer';
