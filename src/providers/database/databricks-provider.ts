/// <reference lib="dom" />
import type { ILogger } from '../../types/logger';
import type { DbtExecutionService, DbtJobPriority } from '../../dbt/execution-service';
import { Priority } from '../../dbt/execution-service';
import type { DatabricksConnection } from './profiles-reader';
import type { CancelSignal, ColumnDefinition, DatabaseProvider, QueryHints, QueryResult } from './database-provider';

/** Databricks SQL Statement Execution API base path */
const DATABRICKS_STATEMENTS_PATH = '/api/2.0/sql/statements';

/** How long to wait between polling attempts (ms) */
const POLL_INTERVAL_MS = 500;

/** Maximum number of polling attempts before giving up */
const MAX_POLL_ATTEMPTS = 120; // 60 seconds

/** Jinja expression detector — if present the SQL must be compiled first */
const JINJA_PATTERN = /\{\{|\{%/;

// ---------------------------------------------------------------------------
// Internal API types (minimal surface from Databricks REST API)
// ---------------------------------------------------------------------------

interface StatementRequest {
	warehouse_id: string;
	statement: string;
	wait_timeout: string;
	on_wait_timeout: 'CONTINUE' | 'CANCEL';
	disposition: 'INLINE' | 'EXTERNAL_LINKS';
	row_limit?: number;
	catalog?: string;
	schema?: string;
}

interface ResultChunk {
	data_array?: string[][];
}

interface StatementResult {
	statement_id: string;
	status: { state: 'SUCCEEDED' | 'FAILED' | 'CANCELED' | 'PENDING' | 'RUNNING'; error?: { message: string } };
	manifest?: {
		schema?: { columns: Array<{ name: string; type_name: string; type_text?: string }> };
		total_row_count?: number;
		truncated?: boolean;
	};
	result?: ResultChunk;
}

// ---------------------------------------------------------------------------
// DatabricksProvider
// ---------------------------------------------------------------------------

/**
 * DatabaseProvider implementation that bypasses the dbt bridge and issues
 * queries directly to the Databricks SQL Statement Execution REST API.
 *
 * Advantages over the dbt show fallback:
 * - Runs in parallel with ongoing dbt commands (no bridge queue contention)
 * - Faster round-trip: no Python subprocess overhead per query
 * - Can cancel in-flight queries via the DELETE statement endpoint
 *
 * Credentials are sourced from the Databricks connection section of profiles.yml.
 * Only personal access token (PAT) authentication is supported; OAuth tokens
 * must be resolved to a PAT before constructing this provider.
 */
export class DatabricksProvider implements DatabaseProvider {
	readonly adapterType = 'databricks';

	private readonly _host: string;
	private readonly _httpPath: string;
	private readonly _token: string;
	private readonly _warehouseId: string;
	private readonly _catalog?: string;
	private readonly _schema?: string;

	constructor(
		connection: DatabricksConnection,
		private readonly executionService: DbtExecutionService,
		private readonly logger: ILogger,
	) {
		// Normalise host: strip trailing slashes and ensure no scheme duplication
		const host = connection.host.replace(/\/+$/, '');
		this._host = host.startsWith('https://') ? host : `https://${host}`;

		// Extract warehouse ID from http_path:  /sql/1.0/warehouses/<id>
		const match = /\/warehouses\/([^/]+)/.exec(connection.http_path);
		if (!match) {
			throw new Error(
				`DatabricksProvider: cannot extract warehouse ID from http_path "${connection.http_path}"`,
			);
		}
		this._warehouseId = match[1];
		this._httpPath = connection.http_path;
		this._token = connection.token;
		this._catalog = connection.catalog;
		this._schema = connection.schema;
	}

	// -------------------------------------------------------------------------
	// DatabaseProvider interface
	// -------------------------------------------------------------------------

	async query(sql: string, limit: number, signal?: CancelSignal, _priority?: DbtJobPriority, hints?: QueryHints): Promise<QueryResult> {
		if (hints?.forceDbtShow) {
			return this._queryViaDbtShow(sql, limit, _priority ?? Priority.Tool);
		}
		const compiled = await this._maybeCompile(sql);
		if (hints?.invalidateCacheTables?.length) {
			await this._refreshTables(hints.invalidateCacheTables, signal);
		}
		this.logger.debug('DatabricksProvider: executing query directly (bypassing dbt)');
		const t0 = performance.now();
		const result = await this._executeStatement(compiled, limit < 0 ? undefined : limit, signal);
		result.executionTimeMs = performance.now() - t0;
		return result;
	}

	async describe(name: string, opts?: { isSource?: boolean; sourceName?: string; qualifiedName?: string }): Promise<ColumnDefinition[]> {
		// Use the pre-built fully-qualified relation name when available (avoids relying on
		// the session catalog/schema to resolve a model that lives in a different schema).
		const qualifiedName = opts?.qualifiedName
			?? (opts?.isSource && opts.sourceName ? `${opts.sourceName}.${name}` : name);

		const sql = `DESCRIBE TABLE ${qualifiedName}`;
		this.logger.trace(`DatabricksProvider: describe ${qualifiedName}`);

		const result = await this._executeStatement(sql, undefined, undefined);
		return result.rows.map(row => ({
			name: String(row['col_name'] ?? row['name'] ?? ''),
			type: String(row['data_type'] ?? row['type'] ?? 'unknown'),
			comment: row['comment'] !== undefined ? String(row['comment']) : undefined,
		})).filter(c => c.name && !c.name.startsWith('#'));
	}

	async listSchemas(database?: string): Promise<string[]> {
		const in_ = database ?? this._catalog;
		const sql = in_ ? `SHOW SCHEMAS IN ${in_}` : 'SHOW SCHEMAS';
		this.logger.trace(`DatabricksProvider: listSchemas (${sql})`);
		const result = await this._executeStatement(sql, undefined, undefined);
		return result.rows.map(r => String(r['databaseName'] ?? r['namespace'] ?? Object.values(r)[0] ?? ''));
	}

	async listTables(schema: string, database?: string): Promise<string[]> {
		const db = database ?? this._catalog;
		const in_ = db ? `${db}.${schema}` : schema;
		const sql = `SHOW TABLES IN ${in_}`;
		this.logger.trace(`DatabricksProvider: listTables (${sql})`);
		const result = await this._executeStatement(sql, undefined, undefined);
		return result.rows.map(r => String(r['tableName'] ?? r['table'] ?? Object.values(r)[0] ?? ''));
	}

	// -------------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------------

	/** If the SQL contains Jinja, compile it via the bridge before sending to Databricks */
	private async _maybeCompile(sql: string): Promise<string> {
		if (!JINJA_PATTERN.test(sql)) return sql;
		this.logger.trace('DatabricksProvider: Jinja detected — compiling inline via bridge');
		return this.executionService.compileInline(sql);
	}

	/** Invalidate the Delta disk cache for a list of fully-qualified table names. */
	private async _refreshTables(tables: string[], signal: CancelSignal | undefined): Promise<void> {
		for (const table of tables) {
			if (signal?.aborted) return;
			this.logger.debug(`DatabricksProvider: REFRESH TABLE ${table}`);
			try {
				await this._executeStatement(`REFRESH TABLE ${table}`, undefined, signal);
			} catch (e) {
				this.logger.warn(`DatabricksProvider: REFRESH TABLE ${table} failed (ignored): ${e}`);
			}
		}
	}

	/**
	 * Execute via dbt show --inline instead of the native REST API.
	 * Used when QueryHints.forceDbtShow is true.
	 */
	private async _queryViaDbtShow(sql: string, limit: number, priority: DbtJobPriority): Promise<QueryResult> {
		const limitArg = limit < 0 ? '-1' : String(limit);
		const args = ['--no-populate-cache', 'show', '--inline', sql, '--limit', limitArg, '--output', 'json'];
		this.logger.debug(`DatabricksProvider: query via dbt show (forced, limit=${limitArg})`);
		const t0 = performance.now();
		const result = await this.executionService.submit({
			type: 'show',
			args,
			priority,
			origin: 'provider',
			label: 'db query (forced dbt show)',
		});
		const executionTimeMs = performance.now() - t0;
		if (!result.success) {
			throw new Error(result.stderr || result.stdout || 'dbt show failed');
		}
		const showLine = result.stdout.split('\n').find(l => l.trimStart().startsWith('{"show"'));
		if (showLine) {
			const data = JSON.parse(showLine.trim()) as Record<string, unknown>;
			const rows = data['show'];
			if (Array.isArray(rows)) {
				const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
				return { columns, rows: rows as Record<string, unknown>[], rowCount: rows.length, executionTimeMs };
			}
		}
		throw new Error(`dbt show output did not contain expected JSON: ${result.stdout.slice(0, 200)}`);
	}

	/** Submit a SQL statement and poll until it completes, then return the result. */
	private async _executeStatement(
		sql: string,
		rowLimit: number | undefined,
		signal: CancelSignal | undefined,
	): Promise<QueryResult> {
		const body: StatementRequest = {
			warehouse_id: this._warehouseId,
			statement: sql,
			// Wait up to 30s inline; if still running, continue polling.
			wait_timeout: '30s',
			on_wait_timeout: 'CONTINUE',
			disposition: 'INLINE',
		};

		if (rowLimit !== undefined) body.row_limit = rowLimit;
		if (this._catalog) body.catalog = this._catalog;
		if (this._schema) body.schema = this._schema;

		this.logger.trace(`DatabricksProvider: POST ${DATABRICKS_STATEMENTS_PATH}`);
		let response = await this._fetch<StatementResult>('POST', DATABRICKS_STATEMENTS_PATH, body);

		const statementId = response.statement_id;
		if (!statementId) {
			throw new Error('DatabricksProvider: statement execution returned no statement_id');
		}

		// Poll until terminal state
		let attempts = 0;
		while (
			response.status.state === 'PENDING' ||
			response.status.state === 'RUNNING'
		) {
			if (signal?.aborted) {
				await this._cancelStatement(statementId);
				throw new Error('DatabricksProvider: query cancelled by caller');
			}

			if (++attempts > MAX_POLL_ATTEMPTS) {
				await this._cancelStatement(statementId);
				throw new Error('DatabricksProvider: query timed out after polling');
			}

			await sleep(POLL_INTERVAL_MS);

			response = await this._fetch<StatementResult>(
				'GET',
				`${DATABRICKS_STATEMENTS_PATH}/${statementId}`,
			);
		}

		if (response.status.state === 'CANCELED') {
			throw new Error('DatabricksProvider: query was cancelled');
		}
		if (response.status.state === 'FAILED') {
			const msg = response.status.error?.message ?? 'unknown error';
			throw new Error(`DatabricksProvider: query failed — ${msg}`);
		}

		// SUCCEEDED — parse result
		return this._parseResult(response);
	}

	private async _cancelStatement(statementId: string): Promise<void> {
		try {
			await this._fetch('POST', `${DATABRICKS_STATEMENTS_PATH}/${statementId}/cancel`);
		} catch (err) {
			this.logger.warn(`DatabricksProvider: failed to cancel statement ${statementId}: ${err}`);
		}
	}

	private _parseResult(response: StatementResult): QueryResult {
		const columns = (response.manifest?.schema?.columns ?? []).map(c => c.name);
		const dataArray = response.result?.data_array ?? [];

		const rows: Record<string, unknown>[] = dataArray.map(rowArr =>
			Object.fromEntries(columns.map((col, i) => [col, rowArr[i] ?? null])),
		);

		return {
			columns,
			rows,
			rowCount: response.manifest?.total_row_count ?? rows.length,
			executionTimeMs: 0, // overwritten by query() after measuring round-trip
		};
	}

	/**
	 * Make an authenticated request to the Databricks REST API.
	 * Uses Node.js native `fetch` (available from Node 18+).
	 */
	private async _fetch<T>(
		method: 'GET' | 'POST' | 'DELETE',
		path: string,
		body?: unknown,
	): Promise<T> {
		const url = `${this._host}${path}`;
		const options: RequestInit = {
			method,
			headers: {
				'Authorization': `Bearer ${this._token}`,
				'Content-Type': 'application/json',
				'Accept': 'application/json',
				'User-Agent': 'dbt-studio-vscode/1.0',
			},
		};

		if (body !== undefined) {
			options.body = JSON.stringify(body);
		}

		let res: Response;
		try {
			res = await fetch(url, options);
		} catch (err) {
			throw new Error(`DatabricksProvider: network error calling ${path}: ${err}`);
		}

		if (!res.ok) {
			let detail = '';
			try {
				detail = await res.text();
			} catch {
				// ignore
			}
			throw new Error(`DatabricksProvider: ${method} ${path} returned ${res.status}: ${detail}`);
		}

		if (res.status === 204 || method === 'DELETE') {
			return {} as T;
		}

		return res.json() as Promise<T>;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}
