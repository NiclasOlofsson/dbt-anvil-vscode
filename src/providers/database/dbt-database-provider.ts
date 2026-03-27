import type { ILogger } from '../../types/logger';
import type { DbtExecutionService } from '../../dbt/execution-service';
import { Priority } from '../../dbt/execution-service';
import type { CancelSignal, ColumnDefinition, DatabaseProvider, QueryResult } from './database-provider';

/**
 * Default DatabaseProvider implementation that routes all operations through
 * the dbt bridge (dbt show --inline / describe_table).
 *
 * This provider uses the existing ExecutionService priority queue and is
 * therefore subject to the same serialisation limits as all other bridge
 * commands.  It acts as the fallback when no adapter-specific provider is
 * available.
 */
export class DbtDatabaseProvider implements DatabaseProvider {
	readonly adapterType: string;

	constructor(
		adapterType: string,
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
	) {
		this.adapterType = adapterType;
	}

	async query(sql: string, limit: number, _signal?: CancelSignal): Promise<QueryResult> {
		const limitArg = limit < 0 ? '-1' : String(limit);
		const args = ['show', '--inline', sql, '--limit', limitArg, '--output', 'json', '--no-populate-cache'];
		this.logger.debug(`DbtDatabaseProvider: query via dbt show (limit=${limitArg})`);

		const result = await this.service.submit({
			type: 'show',
			args,
			priority: Priority.Tool,
			origin: 'provider',
			label: 'db query',
		});

		if (!result.success) {
			throw new Error(result.stderr || result.stdout || 'dbt show failed');
		}

		// dbt show --output json emits one JSON line: {"show": [...rows...]}
		const showLine = result.stdout.split('\n').find(l => l.trimStart().startsWith('{"show"'));
		if (showLine) {
			try {
				const data = JSON.parse(showLine.trim()) as Record<string, unknown>;
				const rows = data['show'];
				if (Array.isArray(rows)) {
					const columns = rows.length > 0 ? Object.keys(rows[0] as Record<string, unknown>) : [];
					return { columns, rows: rows as Record<string, unknown>[], rowCount: rows.length };
				}
			} catch (err) {
				this.logger.warn(`DbtDatabaseProvider: failed to parse dbt show output: ${err}`);
			}
		}

		throw new Error(`dbt show output did not contain expected JSON: ${result.stdout.slice(0, 200)}`);
	}

	async describe(name: string, opts?: { isSource?: boolean; sourceName?: string }): Promise<ColumnDefinition[]> {
		const raw = opts?.isSource && opts.sourceName
			? { describe_table: true, name, source_name: opts.sourceName }
			: { describe_table: true, name };

		const result = await this.service.submit({
			type: 'describe',
			raw,
			priority: Priority.Provider,
			origin: 'provider',
			label: `describe ${name}`,
		});

		const cols = (result.data as Record<string, unknown> | undefined)?.columns as string[] | undefined;
		if (!cols) return [];

		// Bridge returns column names as strings; wrap into ColumnDefinition with unknown type.
		return cols.map(col => {
			if (typeof col === 'string') {
				return { name: col, type: 'unknown' };
			}
			// If the bridge returns objects with name/type, handle that too.
			const c = col as Record<string, unknown>;
			return {
				name: String(c['name'] ?? ''),
				type: String(c['type'] ?? 'unknown'),
				comment: c['comment'] !== undefined ? String(c['comment']) : undefined,
			};
		});
	}

	async listSchemas(_database?: string): Promise<string[]> {
		// dbt show doesn't have a native "list schemas" — run SQL via show --inline
		const sql = 'SHOW SCHEMAS';
		const result = await this.query(sql, -1);
		return result.rows.map(r => String(Object.values(r)[0] ?? ''));
	}

	async listTables(schema: string, _database?: string): Promise<string[]> {
		const sql = `SHOW TABLES IN ${schema}`;
		const result = await this.query(sql, -1);
		return result.rows.map(r => String(Object.values(r)[0] ?? ''));
	}
}
