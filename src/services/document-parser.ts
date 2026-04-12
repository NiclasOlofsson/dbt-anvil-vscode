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
	 * Bridge-specific schema mapping for alias resolution.
	 * `BridgeDocumentParser` forwards this to bridge.py; other implementations ignore it.
	 */
	schemaMapping?: Record<string, Record<string, Record<string, Record<string, object>>>>;
}

/**
 * Seam interface for parsing a single SQL string into a DocumentModel.
 * Implementations: BridgeDocumentParser (bridge.py backend), FtlDocumentParser (Pyodide/sqlglot).
 * ParseService injects this and owns caching, variant expansion, and enrichment.
 */
export interface DocumentParser {
	parse(sql: string, dialect: string, options?: ParseOptions): Promise<DocumentModel>;
}
