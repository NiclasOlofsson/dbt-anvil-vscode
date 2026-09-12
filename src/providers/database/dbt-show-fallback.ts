import type { ILogger } from '../../types/logger';
import type { DbtExecutionService, DbtJobPriority } from '../../dbt/execution-service';
import type { QueryResult } from './database-provider';

/**
 * Execute a query through `dbt show --inline` instead of a native connection.
 * Native providers use this when QueryHints.forceDbtShow is set, so timings can
 * be compared against the bridge path.
 */
export async function queryViaDbtShow(
	executionService: DbtExecutionService,
	logger: ILogger,
	providerName: string,
	sql: string,
	limit: number,
	priority: DbtJobPriority,
): Promise<QueryResult> {
	const limitArg = limit < 0 ? '-1' : String(limit);
	const args = ['--no-populate-cache', 'show', '--inline', sql, '--limit', limitArg, '--output', 'json'];
	logger.debug(`${providerName}: query via dbt show (forced, limit=${limitArg})`);
	const t0 = performance.now();
	const result = await executionService.submit({
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
