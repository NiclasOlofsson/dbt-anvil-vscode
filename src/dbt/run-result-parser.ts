/**
 * Parses dbt run/build/seed output produced with `--log-format json`.
 *
 * Looks for `NodeFinished` events which carry per-node execution status.
 */

import type { DbtLogEvent } from './bridge-runner';

export type RunResultStatus = 'success' | 'error' | 'skipped' | 'warn' | 'fail';

export interface ParsedRunResult {
	/** dbt unique_id, e.g. "model.jaffle_shop.orders". */
	uniqueId: string;
	status: RunResultStatus;
	/** Human-readable message from dbt. */
	message?: string;
	/** Execution time in seconds. */
	executionTime?: number;
}

/**
 * Parse dbt run/build/seed JSON log events and return results keyed by unique_id.
 *
 * Pass `result.events` from a run/build/seed command.
 */
export function parseDbtRunEvents(events: DbtLogEvent[]): Map<string, ParsedRunResult> {
	const results = new Map<string, ParsedRunResult>();

	for (const event of events) {
		if (event.info?.name !== 'NodeFinished') {
			continue;
		}

		const data = event.data ?? {};
		const nodeInfo = data['node_info'] as Record<string, unknown> | undefined;
		const runResult = data['run_result'] as Record<string, unknown> | undefined;

		const uniqueId = typeof nodeInfo?.['unique_id'] === 'string'
			? nodeInfo['unique_id'] as string
			: undefined;

		const rawStatus = typeof nodeInfo?.['node_status'] === 'string'
			? nodeInfo['node_status'] as string
			: typeof runResult?.['status'] === 'string'
				? runResult['status'] as string
				: undefined;

		if (!uniqueId || !rawStatus) {
			continue;
		}

		const executionTime = typeof nodeInfo?.['execution_time'] === 'number'
			? nodeInfo['execution_time'] as number
			: typeof runResult?.['execution_time'] === 'number'
				? runResult['execution_time'] as number
				: undefined;

		results.set(uniqueId, {
			uniqueId,
			status: mapStatus(rawStatus),
			message: event.info.msg,
			executionTime,
		});
	}

	return results;
}

function mapStatus(raw: string): RunResultStatus {
	switch (raw.toLowerCase()) {
		case 'success': return 'success';
		case 'warn': return 'warn';
		case 'fail': return 'fail';
		case 'error': return 'error';
		case 'skipped': return 'skipped';
		default: return 'error';
	}
}
