import type { ParseResult } from './parse-result';

/** Authoritative symbol lists extracted from sqlglot for a specific dialect. */
export interface DialectSymbols {
	/** Lowercase SQL function names (e.g. 'count', 'regexp_extract'). */
	readonly functions: ReadonlySet<string>;
	/** Lowercase sqlglot TokenType names that represent SQL keywords (e.g. 'select', 'qualify'). */
	readonly keywordTokenTypes: ReadonlySet<string>;
	/** Lowercase DataType.Type names (e.g. 'bigint', 'timestamp_ltz'). */
	readonly types: ReadonlySet<string>;
}

export interface SqlParser {
	parse(sql: string, dialect: string, schema?: Record<string, Record<string, string>>): Promise<ParseResult>;
	/** Return the symbol lists for the given dialect. Optional — not all implementations support this. */
	getDialectSymbols?(dialect: string): Promise<DialectSymbols>;
}
