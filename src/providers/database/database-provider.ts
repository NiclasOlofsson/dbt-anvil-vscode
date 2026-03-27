/** Minimal AbortSignal surface area used by database provider implementations. */
export interface CancelSignal {
	readonly aborted: boolean;
	addEventListener(type: 'abort', listener: () => void): void;
	removeEventListener(type: 'abort', listener: () => void): void;
}

export interface QueryResult {
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
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
	 * @param sql    Raw or Jinja SQL to execute.
	 * @param limit  Row limit (-1 for no limit).
	 * @param signal Optional AbortSignal to cancel the query in-flight.
	 */
	query(sql: string, limit: number, signal?: CancelSignal): Promise<QueryResult>;

	/**
	 * Return the column definitions for a dbt model or source.
	 * @param name       Model name (for ref) or table name (for source).
	 * @param opts.isSource    True when describing a source node.
	 * @param opts.sourceName  Source name (required when isSource is true).
	 */
	describe(name: string, opts?: { isSource?: boolean; sourceName?: string }): Promise<ColumnDefinition[]>;

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
