import { describe, expect, it } from 'vitest';
import { model, tableRef, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';

const RULE = 'ninja.aliasing.unique-table';

function check(tokens: ReturnType<typeof tableRef>[]): NinjaViolation[] {
	const m = model({ tokens });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags duplicate aliases', () => {
		const v = check([
			tableRef('orders', 0, 0, 'o'),
			tableRef('other', 1, 0, 'o'),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('o');
	});

	it('no violation for unique aliases', () => {
		expect(check([
			tableRef('orders', 0, 0, 'o'),
			tableRef('customers', 1, 0, 'c'),
		])).toHaveLength(0);
	});

	it('no violation for single table', () => {
		expect(check([tableRef('orders', 0, 0, 'o')])).toHaveLength(0);
	});

	it('flags duplicate bare names (no alias)', () => {
		const v = check([
			tableRef('orders', 0, 0),
			tableRef('orders', 1, 0),
		]);
		expect(v).toHaveLength(1);
	});

	it('case insensitive', () => {
		const v = check([
			tableRef('orders', 0, 0, 'O'),
			tableRef('other', 1, 0, 'o'),
		]);
		expect(v).toHaveLength(1);
	});
});
