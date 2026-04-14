import { describe, expect, it } from 'vitest';
import { model, tableRef, colRef, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';

const RULE = 'ninja.aliasing.unused-alias';

function check(tokens: ReturnType<typeof tableRef | typeof colRef>[]): NinjaViolation[] {
	const m = model({ tokens });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags alias never referenced', () => {
		const v = check([
			tableRef('orders', 0, 0, 'o'),
			colRef('id', 0, 15),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('o');
	});

	it('no violation when alias is referenced', () => {
		expect(check([
			tableRef('orders', 0, 0, 'o'),
			colRef('id', 0, 15, 'o'),
		])).toHaveLength(0);
	});

	it('no violation when table has no alias', () => {
		expect(check([
			tableRef('orders', 0, 0),
			colRef('id', 0, 15),
		])).toHaveLength(0);
	});

	it('case insensitive qualifier match', () => {
		expect(check([
			tableRef('orders', 0, 0, 'O'),
			colRef('id', 0, 15, 'o'),
		])).toHaveLength(0);
	});
});
