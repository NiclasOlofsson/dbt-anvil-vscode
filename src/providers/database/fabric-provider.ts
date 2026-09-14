import * as vscode from 'vscode';
import { Connection, Request, RequestError, TYPES, type ConnectionConfiguration } from 'tedious';
import type { ILogger } from '../../types/logger';
import type { DbtExecutionService, DbtJobPriority } from '../../dbt/execution-service';
import { Priority } from '../../dbt/execution-service';
import type { FabricConnection } from '../../dbt/dbt-project-service';
import type { CancelSignal, ColumnDefinition, DatabaseProvider, QueryHints, QueryResult } from './database-provider';
import { queryViaDbtShow } from './dbt-show-fallback';

/** Entra scope for any Azure SQL / Fabric warehouse TDS endpoint. */
const SQL_SCOPE = 'https://database.windows.net/.default';

/** Jinja expression detector: if present the SQL must be compiled first */
const JINJA_PATTERN = /\{\{|\{%/;

const MAX_CONNECTIONS = 4;
const IDLE_CLOSE_MS = 60_000;
const DEFAULT_QUERY_TIMEOUT_S = 300;
const DEFAULT_LOGIN_TIMEOUT_S = 30;

/** Schemas every Fabric warehouse carries that are never dbt targets. */
const SYSTEM_SCHEMAS = ['sys', 'INFORMATION_SCHEMA', 'guest', 'queryinsights'];

/** The subset of tedious column metadata the provider reads. */
interface TdsColumn {
	colName: string;
	type: { name: string };
	precision?: number;
	scale?: number;
	dataLength?: number;
}

interface TdsParam {
	name: string;
	value: string;
}

interface RunOptions {
	maxRows?: number;
	params?: TdsParam[];
	signal?: CancelSignal;
}

// ---------------------------------------------------------------------------
// FabricProvider
// ---------------------------------------------------------------------------

/**
 * DatabaseProvider for Microsoft Fabric Data Warehouse (dbt-fabric), speaking
 * TDS directly through `tedious`, no ODBC driver and no Python round trip.
 *
 * Authentication: the VS Code Microsoft account. A profile with
 * `authentication: ServicePrincipal` plus client id/secret uses that instead.
 * Every other dbt-fabric mode (CLI, auto, interactive, device code) means "a
 * human's Entra token", which is exactly what the VS Code session provides.
 *
 * Row limits are applied client-side: rows stream until the limit is reached
 * and the request is then cancelled. Wrapping the statement in
 * `SELECT TOP (n) * FROM (...)` is not an option because T-SQL rejects a
 * top-level ORDER BY inside a derived table.
 */
export class FabricProvider implements DatabaseProvider {
	readonly adapterType = 'fabric';

	private readonly _server: string;
	private readonly _port: number;
	private readonly _database: string;
	private readonly _schema: string;
	private readonly _tenantId?: string;
	private readonly _servicePrincipal?: { clientId: string; clientSecret: string; tenantId: string };
	private readonly _encrypt: boolean;
	private readonly _trustServerCertificate: boolean;
	private readonly _connectTimeoutMs: number;
	private readonly _requestTimeoutMs: number;

	private readonly _all = new Set<Connection>();
	private readonly _idle: Array<{ conn: Connection; timer: NodeJS.Timeout }> = [];
	private readonly _waiters: Array<() => void> = [];
	private _pending = 0;

	constructor(
		connection: FabricConnection,
		private readonly executionService: DbtExecutionService,
		private readonly logger: ILogger,
	) {
		const rawHost = connection.host ?? connection.server;
		if (!rawHost) {
			throw new Error('FabricProvider: profile has no host (or server) for the warehouse');
		}
		const { server, port } = parseHost(rawHost);
		this._server = server;
		this._port = connection.port ?? port ?? 1433;
		this._database = connection.database;
		this._schema = connection.schema ?? 'dbo';
		this._tenantId = connection.tenant_id;
		this._encrypt = connection.encrypt ?? true;
		this._trustServerCertificate = connection.trust_cert ?? false;
		this._connectTimeoutMs = (connection.login_timeout || DEFAULT_LOGIN_TIMEOUT_S) * 1000;
		this._requestTimeoutMs = (connection.query_timeout ?? DEFAULT_QUERY_TIMEOUT_S) * 1000;

		const auth = (connection.authentication ?? '').toLowerCase().replace(/[^a-z]/g, '');
		if ((auth === 'serviceprincipal' || auth === 'activedirectoryserviceprincipal')
			&& connection.client_id && connection.client_secret && connection.tenant_id) {
			this._servicePrincipal = {
				clientId: connection.client_id,
				clientSecret: connection.client_secret,
				tenantId: connection.tenant_id,
			};
		}
	}

	// -------------------------------------------------------------------------
	// DatabaseProvider interface
	// -------------------------------------------------------------------------

	async query(sql: string, limit: number, signal?: CancelSignal, priority?: DbtJobPriority, hints?: QueryHints): Promise<QueryResult> {
		if (hints?.forceDbtShow) {
			return queryViaDbtShow(this.executionService, this.logger, 'FabricProvider', sql, limit, priority ?? Priority.Tool);
		}
		const compiled = await this._maybeCompile(sql);
		this.logger.debug('FabricProvider: executing query directly (bypassing dbt)');
		const interactive = priority === Priority.User || priority === Priority.Tool;
		const t0 = performance.now();
		const result = await this._run(compiled, { maxRows: limit < 0 ? undefined : limit, signal }, interactive);
		result.executionTimeMs = performance.now() - t0;
		return result;
	}

	async describe(name: string, opts?: { isSource?: boolean; sourceName?: string; qualifiedName?: string }): Promise<ColumnDefinition[]> {
		const relation = this._resolveRelation(opts?.qualifiedName ?? name, opts?.isSource ? opts.sourceName : undefined);
		this.logger.trace(`FabricProvider: describe ${formatRelation(relation)}`);
		const sql = 'SELECT COLUMN_NAME, DATA_TYPE, CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE, DATETIME_PRECISION'
			+ ` FROM ${quoteIdent(relation.database)}.INFORMATION_SCHEMA.COLUMNS`
			+ ' WHERE TABLE_SCHEMA = @schema AND TABLE_NAME = @table ORDER BY ORDINAL_POSITION';
		const result = await this._run(sql, {
			params: [{ name: 'schema', value: relation.schema }, { name: 'table', value: relation.table }],
		}, false);
		if (result.rows.length === 0) {
			throw new Error(`FabricProvider: relation ${formatRelation(relation)} not found`);
		}
		return result.rows.map(row => ({
			name: String(row['COLUMN_NAME']),
			type: informationSchemaType(row),
		}));
	}

	async listSchemas(database?: string): Promise<string[]> {
		const db = database ?? this._database;
		this.logger.trace(`FabricProvider: listSchemas (${db})`);
		const excluded = SYSTEM_SCHEMAS.map(s => `'${s}'`).join(', ');
		const sql = `SELECT SCHEMA_NAME FROM ${quoteIdent(db)}.INFORMATION_SCHEMA.SCHEMATA`
			+ ` WHERE SCHEMA_NAME NOT IN (${excluded}) AND SCHEMA_NAME NOT LIKE 'db[_]%' ORDER BY SCHEMA_NAME`;
		const result = await this._run(sql, {}, false);
		return result.rows.map(r => String(r['SCHEMA_NAME']));
	}

	async listTables(schema: string, database?: string): Promise<string[]> {
		const db = database ?? this._database;
		this.logger.trace(`FabricProvider: listTables (${db}.${schema})`);
		const sql = `SELECT TABLE_NAME FROM ${quoteIdent(db)}.INFORMATION_SCHEMA.TABLES`
			+ ' WHERE TABLE_SCHEMA = @schema ORDER BY TABLE_NAME';
		const result = await this._run(sql, { params: [{ name: 'schema', value: schema }] }, false);
		return result.rows.map(r => String(r['TABLE_NAME']));
	}

	/** Close every pooled connection. */
	dispose(): void {
		for (const entry of this._idle) clearTimeout(entry.timer);
		this._idle.length = 0;
		for (const conn of this._all) conn.close();
		this._all.clear();
		for (const wake of this._waiters.splice(0)) wake();
	}

	// -------------------------------------------------------------------------
	// Relation resolution
	// -------------------------------------------------------------------------

	private _resolveRelation(qualifiedName: string, sourceName: string | undefined): Relation {
		const parts = splitQualifiedName(qualifiedName);
		if (parts.length >= 3) {
			return { database: parts[parts.length - 3], schema: parts[parts.length - 2], table: parts[parts.length - 1] };
		}
		if (parts.length === 2) {
			return { database: this._database, schema: parts[0], table: parts[1] };
		}
		return { database: this._database, schema: sourceName ?? this._schema, table: parts[0] };
	}

	// -------------------------------------------------------------------------
	// Execution
	// -------------------------------------------------------------------------

	/** If the SQL contains Jinja, compile it via the bridge before sending. */
	private async _maybeCompile(sql: string): Promise<string> {
		if (!JINJA_PATTERN.test(sql)) return sql;
		this.logger.trace('FabricProvider: Jinja detected, compiling inline via bridge');
		return this.executionService.compileInline(sql);
	}

	private async _run(sql: string, opts: RunOptions, interactive: boolean): Promise<QueryResult> {
		const conn = await this._acquire(interactive);
		let healthy = true;
		try {
			return await this._execute(conn, sql, opts);
		} catch (err) {
			healthy = err instanceof FabricQueryError && err.connectionHealthy;
			throw err;
		} finally {
			this._release(conn, healthy);
		}
	}

	private _execute(conn: Connection, sql: string, opts: RunOptions): Promise<QueryResult> {
		return new Promise<QueryResult>((resolve, reject) => {
			let columns: string[] = [];
			const columnTypes: Record<string, string> = {};
			const rows: Record<string, unknown>[] = [];
			let resultSets = 0;
			let truncated = false;
			let cancelledByCaller = false;

			const onAbort = (): void => {
				cancelledByCaller = true;
				conn.cancel();
			};
			opts.signal?.addEventListener('abort', onAbort);

			const request = new Request(sql, (err) => {
				opts.signal?.removeEventListener('abort', onAbort);
				if (err) {
					const code = err instanceof RequestError ? err.code : undefined;
					if (code === 'ECANCEL' && truncated) {
						resolve({ columns, columnTypes, rows, rowCount: rows.length, executionTimeMs: 0 });
						return;
					}
					if (code === 'ECANCEL' && cancelledByCaller) {
						reject(new FabricQueryError('FabricProvider: query cancelled by caller', true));
						return;
					}
					// A RequestError is the server rejecting this statement; the connection is
					// still logged in and reusable. Anything else is transport-level: drop it.
					reject(new FabricQueryError(`FabricProvider: ${err.message}`, err instanceof RequestError));
					return;
				}
				resolve({ columns, columnTypes, rows, rowCount: rows.length, executionTimeMs: 0 });
			});

			for (const p of opts.params ?? []) {
				request.addParameter(p.name, TYPES.NVarChar, p.value);
			}

			request.on('columnMetadata', (meta) => {
				resultSets++;
				if (resultSets > 1) return;
				const cols = (Array.isArray(meta) ? meta : Object.values(meta)) as TdsColumn[];
				columns = cols.map(c => c.colName);
				for (const c of cols) columnTypes[c.colName] = tdsTypeName(c);
			});

			request.on('row', (values: Array<{ value: unknown; metadata: { colName: string } }>) => {
				if (resultSets > 1 || truncated) return;
				if (opts.maxRows !== undefined && rows.length >= opts.maxRows) {
					truncated = true;
					conn.cancel();
					return;
				}
				const row: Record<string, unknown> = {};
				for (const v of values) row[v.metadata.colName] = plainValue(v.value);
				rows.push(row);
			});

			if (opts.signal?.aborted) {
				opts.signal.removeEventListener('abort', onAbort);
				reject(new FabricQueryError('FabricProvider: query cancelled by caller', true));
				return;
			}
			conn.execSql(request);
		});
	}

	// -------------------------------------------------------------------------
	// Connection pool
	// -------------------------------------------------------------------------

	private async _acquire(interactive: boolean): Promise<Connection> {
		for (;;) {
			const idle = this._idle.pop();
			if (idle) {
				clearTimeout(idle.timer);
				return idle.conn;
			}
			if (this._all.size + this._pending < MAX_CONNECTIONS) {
				// Reserve the slot before awaiting, so concurrent first queries do not all open connections.
				this._pending++;
				let conn: Connection;
				try {
					conn = await this._connect(interactive);
				} catch (err) {
					this._wake();
					throw err;
				} finally {
					this._pending--;
				}
				this._all.add(conn);
				conn.on('end', () => {
					this._all.delete(conn);
					this._dropIdle(conn);
					this._wake();
				});
				return conn;
			}
			await new Promise<void>(resolve => this._waiters.push(resolve));
		}
	}

	private _release(conn: Connection, healthy: boolean): void {
		if (!this._all.has(conn)) {
			// Already evicted by its 'end' handler; the slot it held is free either way.
			this._wake();
			return;
		}
		if (!healthy) {
			this._all.delete(conn);
			conn.close();
			this._wake();
			return;
		}
		const timer = setTimeout(() => {
			this._dropIdle(conn);
			this._all.delete(conn);
			conn.close();
		}, IDLE_CLOSE_MS);
		timer.unref();
		this._idle.push({ conn, timer });
		this._wake();
	}

	private _dropIdle(conn: Connection): void {
		const i = this._idle.findIndex(e => e.conn === conn);
		if (i !== -1) {
			clearTimeout(this._idle[i].timer);
			this._idle.splice(i, 1);
		}
	}

	private _wake(): void {
		this._waiters.shift()?.();
	}

	private async _connect(interactive: boolean): Promise<Connection> {
		const config: ConnectionConfiguration = {
			server: this._server,
			authentication: await this._authentication(interactive),
			options: {
				port: this._port,
				database: this._database,
				encrypt: this._encrypt,
				trustServerCertificate: this._trustServerCertificate,
				connectTimeout: this._connectTimeoutMs,
				requestTimeout: this._requestTimeoutMs,
				rowCollectionOnDone: false,
				rowCollectionOnRequestCompletion: false,
				useUTC: true,
				appName: 'dbt-anvil',
			},
		};
		this.logger.trace(`FabricProvider: connecting to ${this._server}:${this._port}/${this._database}`);
		const conn = new Connection(config);
		await new Promise<void>((resolve, reject) => {
			conn.connect((err) => {
				if (err) reject(new Error(`FabricProvider: login to ${this._server} failed: ${err.message}`));
				else resolve();
			});
		});
		return conn;
	}

	private async _authentication(interactive: boolean): Promise<ConnectionConfiguration['authentication']> {
		if (this._servicePrincipal) {
			return { type: 'azure-active-directory-service-principal-secret', options: this._servicePrincipal };
		}
		const scopes = [SQL_SCOPE];
		if (this._tenantId) scopes.push(`VSCODE_TENANT:${this._tenantId}`);

		let session = await vscode.authentication.getSession('microsoft', scopes, { silent: true });
		if (!session && interactive) {
			session = await vscode.authentication.getSession('microsoft', scopes, { createIfNone: true });
		}
		if (!session) {
			// No options: VS Code shows the sign-in badge on the Accounts menu without a modal.
			vscode.authentication.getSession('microsoft', scopes, {}).then(undefined, () => undefined);
			throw new Error('FabricProvider: not signed in to Microsoft. Sign in from the Accounts menu to query the warehouse.');
		}
		return { type: 'azure-active-directory-access-token', options: { token: session.accessToken } };
	}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Relation {
	database: string;
	schema: string;
	table: string;
}

/** A failed statement, tagged with whether the pooled connection survived it. */
class FabricQueryError extends Error {
	constructor(message: string, readonly connectionHealthy: boolean) {
		super(message);
	}
}

/** Split `a.b.c` on dots outside `[...]`, unquoting each part (`]]` is an escaped `]`). */
function splitQualifiedName(name: string): string[] {
	const parts: string[] = [];
	let current = '';
	let inBrackets = false;
	for (let i = 0; i < name.length; i++) {
		const ch = name[i];
		if (inBrackets) {
			if (ch === ']') {
				if (name[i + 1] === ']') {
					current += ']';
					i++;
				} else {
					inBrackets = false;
				}
			} else {
				current += ch;
			}
		} else if (ch === '[') {
			inBrackets = true;
		} else if (ch === '.') {
			parts.push(current.trim());
			current = '';
		} else {
			current += ch;
		}
	}
	parts.push(current.trim());
	return parts;
}

/** Accepts `host`, `tcp:host`, `host,port` and `tcp:host,port`. */
function parseHost(raw: string): { server: string; port?: number } {
	let s = raw.trim().replace(/^tcp:/i, '');
	let port: number | undefined;
	const comma = s.lastIndexOf(',');
	if (comma !== -1) {
		port = Number(s.slice(comma + 1));
		s = s.slice(0, comma);
	}
	return { server: s, port: Number.isFinite(port) ? port : undefined };
}

function quoteIdent(name: string): string {
	return `[${name.replace(/]/g, ']]')}]`;
}

function formatRelation(r: Relation): string {
	return `${quoteIdent(r.database)}.${quoteIdent(r.schema)}.${quoteIdent(r.table)}`;
}

/** Type string from an INFORMATION_SCHEMA.COLUMNS row, e.g. varchar(8000), decimal(19,4), datetime2(6). */
function informationSchemaType(row: Record<string, unknown>): string {
	const base = String(row['DATA_TYPE']).toLowerCase();
	const charLen = row['CHARACTER_MAXIMUM_LENGTH'];
	const precision = row['NUMERIC_PRECISION'];
	const scale = row['NUMERIC_SCALE'];
	const dtPrecision = row['DATETIME_PRECISION'];
	switch (base) {
		case 'varchar': case 'nvarchar': case 'char': case 'nchar': case 'varbinary': case 'binary':
			return charLen === null || charLen === undefined ? base : `${base}(${charLen === -1 ? 'max' : charLen})`;
		case 'decimal': case 'numeric':
			return `${base}(${precision},${scale})`;
		case 'datetime2': case 'datetimeoffset': case 'time':
			return dtPrecision === null || dtPrecision === undefined ? base : `${base}(${dtPrecision})`;
		default:
			return base;
	}
}

/** Type string from tedious column metadata, resolving the nullable N-variants to their concrete type. */
function tdsTypeName(c: TdsColumn): string {
	const raw = c.type.name.toLowerCase();
	const len = c.dataLength;
	switch (raw) {
		case 'intn':
			return ({ 1: 'tinyint', 2: 'smallint', 4: 'int', 8: 'bigint' } as Record<number, string>)[len ?? 4] ?? 'int';
		case 'floatn':
			return len === 4 ? 'real' : 'float';
		case 'bitn':
			return 'bit';
		case 'moneyn':
			return len === 4 ? 'smallmoney' : 'money';
		case 'datetimen':
			return len === 4 ? 'smalldatetime' : 'datetime';
		case 'daten':
			return 'date';
		case 'uniqueidentifiern':
			return 'uniqueidentifier';
		case 'decimaln': case 'numericn': case 'decimal': case 'numeric':
			return `${raw.replace(/n$/, '')}(${c.precision},${c.scale})`;
		case 'datetime2n': case 'datetime2': case 'datetimeoffsetn': case 'datetimeoffset': case 'timen': case 'time':
			return `${raw.replace(/n$/, '')}(${c.scale})`;
		case 'varchar': case 'char': case 'varbinary': case 'binary':
			return len === undefined ? raw : `${raw}(${len === 65535 ? 'max' : len})`;
		case 'nvarchar': case 'nchar':
			return len === undefined ? raw : `${raw}(${len === 65535 ? 'max' : len / 2})`;
		default:
			return raw;
	}
}

/** Keep row values JSON-friendly for the result panel: dates as ISO strings, binaries as hex. */
function plainValue(v: unknown): unknown {
	if (v instanceof Date) return v.toISOString();
	if (Buffer.isBuffer(v)) return `0x${v.toString('hex')}`;
	return v;
}
