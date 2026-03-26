/**
 * Parses dbt test output produced with `--log-format json`.
 *
 * Each stdout line from dbt is a JSON log event. We look for `LogTestResult`
 * events which carry the per-test name and status.
 */

export type TestResultStatus = 'pass' | 'fail' | 'error' | 'skip' | 'warn';

export interface ParsedTestResult {
	/** Short test name (matches the last segment of the dbt unique_id). */
	name: string;
	status: TestResultStatus;
	/** Human-readable message from dbt, e.g. "FAIL 2 not_null_orders_id". */
	message?: string;
	/** Number of failing rows, if available. */
	failures?: number;
	/** Execution time in seconds, as reported by dbt. */
	executionTime?: number;
}

interface DbtLogEvent {
	data?: Record<string, unknown>;
	info?: {
		name?: string;
		msg?: string;
	};
}

/**
 * Parse dbt test JSON log output and return results keyed by the dbt unique_id
 * (e.g. "test.jaffle_shop.not_null_customers_customer_id.5c9bf9911d").
 *
 * Pass `result.stdout` from a test command submitted with `--log-format json`.
 */
export function parseDbtTestOutput(stdout: string): Map<string, ParsedTestResult> {
	const results = new Map<string, ParsedTestResult>();

	for (const rawLine of stdout.split('\n')) {
		const line = rawLine.trim();
		if (!line || line.startsWith('{"success":')) {
			continue;
		}

		let event: DbtLogEvent;
		try {
			event = JSON.parse(line) as DbtLogEvent;
		} catch {
			continue;
		}

		if (event.info?.name !== 'LogTestResult') {
			continue;
		}

		const data = event.data ?? {};
		const name = data['name'] as string | undefined;
		const rawStatus = data['status'] as string | undefined;
		const nodeInfo = data['node_info'] as Record<string, unknown> | undefined;
		const uniqueId = typeof nodeInfo?.['unique_id'] === 'string'
			? nodeInfo['unique_id'] as string
			: name; // fallback to name if node_info.unique_id absent

		if (!uniqueId || !rawStatus) {
			continue;
		}

		const status = mapStatus(rawStatus);
		const failures = typeof data['failures'] === 'number'
			? data['failures']
			: typeof data['num_failures'] === 'number'
				? data['num_failures'] as number
				: undefined;

		const executionTime = typeof data['execution_time'] === 'number'
			? data['execution_time'] as number
			: typeof data['elapsed_time'] === 'number'
				? data['elapsed_time'] as number
				: undefined;

		results.set(uniqueId, {
			name: name ?? uniqueId,
			status,
			message: event.info.msg,
			failures,
			executionTime,
		});
	}

	return results;
}

function mapStatus(raw: string): TestResultStatus {
	switch (raw.toLowerCase()) {
		case 'pass': return 'pass';
		case 'warn': return 'warn';
		case 'fail': return 'fail';
		case 'error': return 'error';
		case 'skip': return 'skip';
		default: return 'fail';
	}
}
