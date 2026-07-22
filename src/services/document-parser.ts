import type { DocumentModel } from './parse-service';
import type { DialectSymbols } from '../ftl/sql-tokens';
import type { LineageResult } from '../ftl/sqllens/lineage';
import type { CompleteOptions, CompletionResult, SignatureHelpInfo, TemplateProvider } from '../ftl/sqllens/api';

/**
 * Options passed to a DocumentParser.parse() call.
 */
export interface ParseOptions {
	/** Schema passed to qualify() — enables star-selector expansion and column typing
	 *  for PLAIN (physical-name) table references. Compiled-SQL paths use this. */
	schema?: Record<string, Record<string, string>>;
	/**
	 * The enriched per-parse template provider (ParseService builds it from the
	 * manifest + describe cache). When present it wins over the AdapterContext's
	 * shape-only provider AND serves as qualify()'s SchemaProvider, so templated
	 * ref()/source() sources resolve real warehouse columns.
	 */
	templateProvider?: TemplateProvider;
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
	 * Editor completion candidates (keywords, functions, columns, tables, and — in a jinja
	 * call slot — the provider's `templateCandidates`) at `offset`. `provider` supplies the
	 * host catalog sqllens has no way to know; without one only the static dbt overlay answers.
	 */
	completeAt?(sql: string, offset: number, provider?: TemplateProvider, opts?: CompleteOptions): CompletionResult;
	/** Signature help for the SQL function call enclosing `offset`, or null. */
	signatureAt?(sql: string, offset: number, provider?: TemplateProvider): SignatureHelpInfo | null;
	/**
	 * Trace column lineage for one output column. Returns the lineage result or a
	 * structured `{ error }`. Bypasses ParseService caching — called directly by
	 * GetColumnLineageTool.
	 */
	traceLineageV2?(sql: string, columnName: string, schemaJson: string): Promise<LineageResult | { error: string }>;
}
