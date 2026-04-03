import * as path from 'node:path';
import { DuckDBInstance } from '@duckdb/node-api';
import type { ILogger } from '../../types/logger';
import type { DbtExecutionService, DbtJobPriority } from '../../dbt/execution-service';
import { Priority } from '../../dbt/execution-service';
import type { DuckdbConnection } from './profiles-reader';
import type { CancelSignal, ColumnDefinition, DatabaseProvider, QueryHints, QueryResult } from './database-provider';

const JINJA_PATTERN = /\{\{|\{%/;

export class DuckdbProvider implements DatabaseProvider {
	readonly adapterType = 'duckdb';

	private readonly _dbPath: string;
	private _instance: DuckDBInstance | undefined;

	constructor(
		connection: DuckdbConnection,
		projectDir: string,
		private readonly executionService: DbtExecutionService,
		private readonly logger: ILogger,
	) {
		const p = connection.path;
		this._dbPath = path.isAbsolute(p) ? p : path.join(projectDir, p);
	}

	async query(sql: string, limit: number, _signal?: CancelSignal, _priority?: DbtJobPriority, hints?: QueryHints): Promise<QueryResult> {
		if (hints?.forceDbtShow) {
			return this._queryViaDbtShow(sql, limit, _priority ?? Priority.Tool);
		}
		const compiled = await this._maybeCompile(sql);
		this.logger.debug('DuckdbProvider: executing query directly');
		const t0 = performance.now();
		const limitedSql = limit >= 0 ? `SELECT * FROM (${compiled}) __q LIMIT ${limit}` : compiled;
		const result = await this._runSql(limitedSql);
		result.executionTimeMs = performance.now() - t0;
		return result;
	}

	async describe(name: string, opts?: { isSource?: boolean; sourceName?: string; qualifiedName?: string }): Promise<ColumnDefinition[]> {
		const qualifiedName = opts?.qualifiedName
			?? (opts?.isSource && opts.sourceName ? `${opts.sourceName}.${name}` : name);
		this.logger.trace(`DuckdbProvider: describe ${qualifiedName}`);
		const result = await this._runSql(`DESCRIBE ${qualifiedName}`);
		return result.rows.map(row => ({
			name: String(row['column_name'] ?? ''),
			type: String(row['column_type'] ?? 'unknown'),
		})).filter(c => c.name !== '');
	}

	async listSchemas(_database?: string): Promise<string[]> {
		this.logger.trace('DuckdbProvider: listSchemas');
		const result = await this._runSql(
			'SELECT schema_name FROM information_schema.schemata ORDER BY schema_name',
		);
		return result.rows.map(r => String(r['schema_name'] ?? Object.values(r)[0] ?? ''));
	}

	async listTables(schema: string, _database?: string): Promise<string[]> {
		this.logger.trace(`DuckdbProvider: listTables (${schema})`);
		const instance = await this._getInstance();
		const conn = await instance.connect();
		try {
			const prepared = await conn.prepare(
				'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name',
			);
			prepared.bindVarchar(1, schema);
			const reader = await prepared.runAndReadAll();
			const rows = reader.getRowObjectsJson() as Record<string, unknown>[];
			return rows.map(r => String(r['table_name'] ?? Object.values(r)[0] ?? ''));
		} finally {
			conn.closeSync();
		}
	}

	private async _runSql(sql: string): Promise<QueryResult> {
		const instance = await this._getInstance();
		const conn = await instance.connect();
		try {
			const reader = await conn.runAndReadAll(sql);
			const columnNames = reader.columnNames();
			const columnTypesArr = reader.columnTypes();
			const rowObjects = reader.getRowObjectsJson() as Record<string, unknown>[];
			const columnTypes: Record<string, string> = {};
			columnNames.forEach((n, i) => { columnTypes[n] = columnTypesArr[i].toString(); });
			return {
				columns: columnNames,
				columnTypes,
				rows: rowObjects,
				rowCount: rowObjects.length,
				executionTimeMs: 0,
			};
		} finally {
			conn.closeSync();
		}
	}

	private async _getInstance(): Promise<DuckDBInstance> {
		if (!this._instance) {
			this._instance = await DuckDBInstance.create(this._dbPath, { access_mode: 'READ_ONLY' });
		}
		return this._instance;
	}

	private async _maybeCompile(sql: string): Promise<string> {
		if (!JINJA_PATTERN.test(sql)) return sql;
		this.logger.trace('DuckdbProvider: Jinja detected — compiling inline via bridge');
		return this.executionService.compileInline(sql);
	}

	private async _queryViaDbtShow(sql: string, limit: number, priority: DbtJobPriority): Promise<QueryResult> {
		const limitArg = limit < 0 ? '-1' : String(limit);
		const args = ['--no-populate-cache', 'show', '--inline', sql, '--limit', limitArg, '--output', 'json'];
		this.logger.debug(`DuckdbProvider: query via dbt show (forced, limit=${limitArg})`);
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
		const stdout = result.stdout;
		const firstBrace = stdout.indexOf('{');
		if (firstBrace !== -1) {
			let depth = 0;
			let end = -1;
			for (let i = firstBrace; i < stdout.length; i++) {
				if (stdout[i] === '{') depth++;
				else if (stdout[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
			}
			if (end !== -1) {
				const data = JSON.parse(stdout.slice(firstBrace, end + 1)) as Record<string, unknown>;
				const rows = data['show'];
				if (Array.isArray(rows)) {
					const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
					return { columns, rows: rows as Record<string, unknown>[], rowCount: rows.length, executionTimeMs };
				}
			}
		}
		throw new Error(`dbt show output did not contain expected JSON: ${result.stdout.slice(0, 200)}`);
	}
}
