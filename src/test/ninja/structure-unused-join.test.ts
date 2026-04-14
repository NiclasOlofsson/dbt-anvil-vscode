import { describe, expect, it } from 'vitest';
import { model, tableRef, colRef, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';

const RULE = 'ninja.structure.unused-join';

function check(tokens: ReturnType<typeof tableRef | typeof colRef>[]): NinjaViolation[] {
	const m = model({ tokens });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags joined table with no column refs', () => {
		const v = check([
			tableRef('orders', 0, 0, 'o'),
			tableRef('customers', 1, 0, 'c'),
			colRef('id', 0, 15, 'o'),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('customers');
	});

	it('no violation when all tables are referenced', () => {
		expect(check([
			tableRef('orders', 0, 0, 'o'),
			tableRef('customers', 1, 0, 'c'),
			colRef('id', 0, 15, 'o'),
			colRef('name', 1, 15, 'c'),
		])).toHaveLength(0);
	});

	it('no violation with single table', () => {
		expect(check([
			tableRef('orders', 0, 0, 'o'),
			colRef('id', 0, 15, 'o'),
		])).toHaveLength(0);
	});

	it('uses bare name when no alias', () => {
		const v = check([
			tableRef('orders', 0, 0),
			tableRef('customers', 1, 0),
			colRef('id', 0, 15, 'orders'),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('customers');
	});

	it('no violation when joined table has no alias and there are unqualified column refs', () => {
		// cte_home_margin is joined without alias; columns appear unqualified
		// → can't determine if they come from this table; must not flag
		const v = check([
			tableRef('some_table', 0, 0, 't'),
			tableRef('cte_home_margin', 1, 0),   // no alias
			colRef('team', 2, 0, 't'),            // qualified ref (some_table)
			colRef('home_pt_diff', 3, 0),         // unqualified — might be from cte_home_margin
		]);
		expect(v).toHaveLength(0);
	});
});
