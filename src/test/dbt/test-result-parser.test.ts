import { describe, it, expect } from 'vitest';
import { parseDbtTestOutput } from '../../dbt/test-result-parser';

// Sample dbt JSON log line builder
function logLine(name: string, status: string, msg: string, failures?: number, executionTime?: number, uniqueId?: string): string {
	return JSON.stringify({
		data: {
			name,
			status,
			...(failures !== undefined ? { failures, num_failures: failures } : {}),
			...(executionTime !== undefined ? { execution_time: executionTime } : {}),
			...(uniqueId !== undefined ? { node_info: { unique_id: uniqueId } } : {}),
		},
		info: {
			name: 'LogTestResult',
			msg,
		},
	});
}

describe('parseDbtTestOutput', () => {
	it('returns empty map for empty stdout', () => {
		expect(parseDbtTestOutput('')).toEqual(new Map());
	});

	it('returns empty map for non-JSON lines only', () => {
		const stdout = 'Running with dbt=1.8.0\nFound 10 models, 5 tests';
		expect(parseDbtTestOutput(stdout)).toEqual(new Map());
	});

	it('parses a single passing test', () => {
		const stdout = logLine('not_null_orders_id', 'pass', 'PASS not_null_orders_id', undefined, 0.456);
		const results = parseDbtTestOutput(stdout);
		expect(results.size).toBe(1);
		const r = results.get('not_null_orders_id');
		expect(r?.status).toBe('pass');
		expect(r?.message).toBe('PASS not_null_orders_id');
		expect(r?.executionTime).toBe(0.456);
	});

	it('parses a failing test', () => {
		const stdout = logLine('not_null_orders_amount', 'fail', 'FAIL 3 not_null_orders_amount', 3, 0.123);
		const results = parseDbtTestOutput(stdout);
		expect(results.size).toBe(1);
		const r = results.get('not_null_orders_amount');
		expect(r?.status).toBe('fail');
		expect(r?.failures).toBe(3);
		expect(r?.executionTime).toBe(0.123);
	});

	it('parses an errored test', () => {
		const stdout = logLine('unique_orders_id', 'error', 'ERROR unique_orders_id');
		const results = parseDbtTestOutput(stdout);
		expect(results.get('unique_orders_id')?.status).toBe('error');
	});

	it('parses a skipped test', () => {
		const stdout = logLine('not_null_items_id', 'skip', 'SKIP not_null_items_id');
		const results = parseDbtTestOutput(stdout);
		expect(results.get('not_null_items_id')?.status).toBe('skip');
	});

	it('parses a warn test as warn', () => {
		const stdout = logLine('accepted_values_status', 'warn', 'WARN accepted_values_status');
		const results = parseDbtTestOutput(stdout);
		expect(results.get('accepted_values_status')?.status).toBe('warn');
	});

	it('parses multiple tests from a single output', () => {
		const lines = [
			'Running with dbt=1.8.0',
			logLine('not_null_orders_id', 'pass', 'PASS not_null_orders_id'),
			logLine('unique_orders_id', 'pass', 'PASS unique_orders_id'),
			logLine('not_null_orders_amount', 'fail', 'FAIL 2 not_null_orders_amount', 2),
			logLine('accepted_values_status', 'skip', 'SKIP accepted_values_status'),
			'{"success": false}',
		];
		const results = parseDbtTestOutput(lines.join('\n'));
		expect(results.size).toBe(4);
		expect(results.get('not_null_orders_id')?.status).toBe('pass');
		expect(results.get('unique_orders_id')?.status).toBe('pass');
		expect(results.get('not_null_orders_amount')?.status).toBe('fail');
		expect(results.get('not_null_orders_amount')?.failures).toBe(2);
		expect(results.get('accepted_values_status')?.status).toBe('skip');
	});

	it('skips the bridge completion marker line', () => {
		const stdout = '{"success": true}';
		expect(parseDbtTestOutput(stdout)).toEqual(new Map());
	});

	it('skips non-LogTestResult events', () => {
		const otherEvent = JSON.stringify({
			data: { name: 'some_test', status: 'pass' },
			info: { name: 'LogSomeOtherEvent', msg: 'Something else' },
		});
		expect(parseDbtTestOutput(otherEvent)).toEqual(new Map());
	});

	it('skips events missing name or status', () => {
		const noName = JSON.stringify({
			data: { status: 'pass' },
			info: { name: 'LogTestResult', msg: 'PASS ?' },
		});
		const noStatus = JSON.stringify({
			data: { name: 'my_test' },
			info: { name: 'LogTestResult', msg: 'PASS my_test' },
		});
		const results1 = parseDbtTestOutput(noName);
		const results2 = parseDbtTestOutput(noStatus);
		expect(results1.size).toBe(0);
		expect(results2.size).toBe(0);
	});

	it('uses num_failures as fallback when failures field is absent', () => {
		const line = JSON.stringify({
			data: { name: 'some_test', status: 'fail', num_failures: 5 },
			info: { name: 'LogTestResult', msg: 'FAIL 5 some_test' },
		});
		const results = parseDbtTestOutput(line);
		expect(results.get('some_test')?.failures).toBe(5);
	});

	it('does not set executionTime when field is absent', () => {
		const stdout = logLine('my_test', 'pass', 'PASS my_test');
		const results = parseDbtTestOutput(stdout);
		expect(results.get('my_test')?.executionTime).toBeUndefined();
	});

	it('maps unknown status to fail', () => {
		const line = JSON.stringify({
			data: { name: 'weird_test', status: 'unknown_status' },
			info: { name: 'LogTestResult', msg: 'UNKNOWN weird_test' },
		});
		const results = parseDbtTestOutput(line);
		expect(results.get('weird_test')?.status).toBe('fail');
	});

	it('keys by node_info.unique_id when present', () => {
		const uid = 'test.jaffle_shop.not_null_customers_customer_id.5c9bf9911d';
		const stdout = logLine('not_null_customers_customer_id', 'pass', 'PASS not_null_customers_customer_id', undefined, 0.66, uid);
		const results = parseDbtTestOutput(stdout);
		// Should be keyed by the full unique_id, not the short name
		expect(results.get(uid)?.status).toBe('pass');
		expect(results.get(uid)?.executionTime).toBe(0.66);
		expect(results.has('not_null_customers_customer_id')).toBe(false);
	});

	it('falls back to name as key when node_info.unique_id is absent', () => {
		const stdout = logLine('my_test', 'pass', 'PASS my_test', undefined, 0.1);
		const results = parseDbtTestOutput(stdout);
		expect(results.get('my_test')?.status).toBe('pass');
	});
});
