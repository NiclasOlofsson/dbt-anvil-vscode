import type { DocumentModel } from './parse-service';
import type { DialectSymbols } from '../ftl/sql-tokens';
import type { LineageResult } from '../ftl/sqllens/lineage';

/**
 * Options passed to a DocumentParser.parse() call.
 * Both fields are enrichment hints that implementations may use or ignore
 * depending on how their backend resolves column information.
 */
export interface ParseOptions {
	/** Schema passed to qualify() — enables star-selector expansion and column typing. */
	schema?: Record<string, Record<string, string>>;
	/**
	 * Schema mapping for alias resolution. Implementations may use or ignore it.
	 */
	schemaMapping?: Record<string, Record<string, Record<string, Record<string, object>>>>;
}

/**
 * Seam interface for parsing a single SQL string into a DocumentModel.
 * Implementation: SqllensDocumentParser.
 * ParseService injects this and owns caching, variant expansion, and enrichment.
 */
export interface DocumentParser {
	parse(sql: string, options?: ParseOptions): Promise<DocumentModel>;
	/** Decompose compiled SQL into debug frames. */
	decomposeQuery?(compiledSql: string): Promise<string>;
	/** Return the dialect symbol lists (functions, keyword types, data types). */
	getDialectSymbols?(): Promise<DialectSymbols | undefined>;
	/**
	 * Trace column lineage for one output column. Returns the lineage result or a
	 * structured `{ error }`. Bypasses ParseService caching — called directly by
	 * GetColumnLineageTool.
	 */
	traceLineageV2?(sql: string, columnName: string, schemaJson: string): Promise<LineageResult | { error: string }>;
}
