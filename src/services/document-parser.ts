import type { DocumentModel } from './parse-service';

/**
 * Options passed to a DocumentParser.parse() call.
 * Both fields are enrichment hints that implementations may use or ignore
 * depending on how their backend resolves column information.
 */
export interface ParseOptions {
	/** Schema passed to sqlglot qualify() — enables star-selector expansion and column typing. */
	schema?: Record<string, Record<string, string>>;
	/**
	 * Schema mapping for alias resolution. Implementations may use or ignore it.
	 */
	schemaMapping?: Record<string, Record<string, Record<string, Record<string, object>>>>;
}

/**
 * Seam interface for parsing a single SQL string into a DocumentModel.
 * Current implementation: FtlDocumentParser (Pyodide/sqlglot).
 * ParseService injects this and owns caching, variant expansion, and enrichment.
 */
export interface DocumentParser {
	parse(sql: string, options?: ParseOptions): Promise<DocumentModel>;
	/** Decompose compiled SQL into debug frames. Only implemented by FtlDocumentParser. */
	decomposeQuery?(compiledSql: string): Promise<string>;
}
