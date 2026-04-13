import type { DbtJobPriority } from '../../dbt/execution-service';

/**
 * Optional hints passed to DatabaseProvider.query() to influence execution behaviour.
 * Providers are free to ignore any hint they do not support.
 */
export interface QueryHints {
	/**
	 * When true, bypass the native adapter and route through dbt show --inline instead.
	 * Useful for comparing native vs dbt-show timings during profiling.
	 * Only meaningful for providers that have a native execution path (e.g. DatabricksProvider).
	 */
	forceDbtShow?: boolean;
}

/** Minimal AbortSignal surface area used by database provider implementations. */
export interface CancelSignal {
	readonly aborted: boolean;
	addEventListener(type: 'abort', listener: () => void): void;
	removeEventListener(type: 'abort', listener: () => void): void;
}

export interface QueryResult {
	columns: string[];
	/** Optional map of column name → database type string (e.g. "INT", "VARCHAR", "TIMESTAMP"). */
	columnTypes?: Record<string, string>;
	rows: Record<string, unknown>[];
	rowCount: number;
	/** Wall-clock milliseconds from sending the request to receiving the full response. */
	executionTimeMs: number;
}

export interface ColumnDefinition {
	name: string;
	type: string;
	comment?: string;
}

/**
 * Abstraction over database-specific query execution.
 *
 * The default implementation routes all operations through the dbt bridge
 * (dbt show --inline). Adapter-specific implementations can bypass the
 * serialised bridge queue and connect directly to the warehouse, enabling
 * parallel query execution alongside ongoing dbt commands.
 */
export interface DatabaseProvider {
	readonly adapterType: string;

	/**
	 * Execute a SQL query and return rows.
	 * The SQL may contain Jinja templating; implementations are responsible for
	 * compiling it before execution when bypassing dbt show.
	 * @param sql      Raw or Jinja SQL to execute.
	 * @param limit    Row limit (-1 for no limit).
	 * @param signal   Optional AbortSignal to cancel the query in-flight.
	 * @param priority Queue priority for bridge-routed adapters. Defaults to Tool.
	 *                 Pass Priority.Background for low-priority background tasks.
	 * @param hints    Optional execution hints (e.g. cache invalidation, force dbt show).
	 */
	query(sql: string, limit: number, signal?: CancelSignal, priority?: DbtJobPriority, hints?: QueryHints): Promise<QueryResult>;

	/**
	 * Return the column definitions for a dbt model or source.
	 * @param name                 Model name (for ref) or table name (for source).
	 * @param opts.isSource        True when describing a source node.
	 * @param opts.sourceName      Source name (required when isSource is true).
	 * @param opts.qualifiedName   Pre-built fully-qualified relation name (e.g. catalog.schema.table).
	 *                             Adapter-specific providers that bypass dbt should use this instead of
	 *                             relying on the session catalog/schema to resolve an unqualified name.
	 * @param opts.externalLocation Resolved external file path for adapter-defined external sources
	 *                              (e.g. DuckDB's external_location CSV path). When set, the provider
	 *                              should describe the file directly rather than a warehouse table.
	 */
	describe(name: string, opts?: { isSource?: boolean; sourceName?: string; qualifiedName?: string; externalLocation?: string }): Promise<ColumnDefinition[]>;

	/**
	 * List schemas available in the connected database/catalog.
	 * @param database Optional catalog/database to scope the listing.
	 */
	listSchemas(database?: string): Promise<string[]>;

	/**
	 * List tables/views within a schema.
	 * @param schema   Schema to list.
	 * @param database Optional catalog/database to scope the listing.
	 */
	listTables(schema: string, database?: string): Promise<string[]>;
}
