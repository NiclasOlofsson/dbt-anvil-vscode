import { describe, expect, it } from 'vitest';
import { model, tableRef, colRef, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';

const RULE = 'ninja.aliasing.self-alias';

function check(tokens: ReturnType<typeof tableRef | typeof colRef>[]): NinjaViolation[] {
	const m = model({ tokens });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags table aliased to its own name', () => {
		const v = check([tableRef('orders', 0, 0, 'orders')]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('orders');
		expect(v[0].fix).toBeDefined();
	});

	it('ignores table aliased to different name', () => {
		expect(check([tableRef('orders', 0, 0, 'o')])).toHaveLength(0);
	});

	it('ignores table with no alias', () => {
		expect(check([tableRef('orders', 0, 0)])).toHaveLength(0);
	});

	it('case insensitive comparison', () => {
		const v = check([tableRef('Orders', 0, 0, 'ORDERS')]);
		expect(v).toHaveLength(1);
	});
});
