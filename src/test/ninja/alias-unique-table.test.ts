import { describe, expect, it } from 'vitest';
import { model, tableRef, cte, run, violationsFor } from './helpers';
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

	it('no violation when same table appears in different CTE scopes', () => {
		// qualify() synthesises aliases — they must be skipped entirely, including
		// within a UNION ALL where the same table appears twice in one CTE.
		const tokA: ReturnType<typeof tableRef> = {
			type: 'table_ref', name: 'orders', line: 2, col: 5, endCol: 11,
			alias: 'orders', synthesized: true,
		};
		const tokB: ReturnType<typeof tableRef> = {
			type: 'table_ref', name: 'orders', line: 7, col: 5, endCol: 11,
			alias: 'orders', synthesized: true,
		};
		const cteA = cte('cte_a', 1, 4);
		const cteB = cte('cte_b', 6, 9);
		const m = model({ tokens: [tokA, tokB], ctes: [cteA, cteB] });
		const result = run('select 1', {}, m);
		expect(violationsFor(result, RULE)).toHaveLength(0);
	});

	it('no violation when same table appears twice in a UNION ALL branch (synthesized)', () => {
		// Both refs are in the same CTE scope but synthesized — must not collide.
		const tokA: ReturnType<typeof tableRef> = {
			type: 'table_ref', name: 'orders', line: 2, col: 5, endCol: 11,
			alias: 'orders', synthesized: true,
		};
		const tokB: ReturnType<typeof tableRef> = {
			type: 'table_ref', name: 'orders', line: 5, col: 5, endCol: 11,
			alias: 'orders', synthesized: true,
		};
		const cteA = cte('cte_a', 1, 7);
		const m = model({ tokens: [tokA, tokB], ctes: [cteA] });
		const result = run('select 1', {}, m);
		expect(violationsFor(result, RULE)).toHaveLength(0);
	});

	it('flags duplicate aliases within the same CTE scope', () => {
		// Two aliased joins with the same alias inside one CTE body.
		const tokA = tableRef('orders', 2, 5, 'o');
		const tokB = tableRef('other',  3, 5, 'o');
		const cteA = cte('cte_a', 1, 5);
		const m = model({ tokens: [tokA, tokB], ctes: [cteA] });
		const result = run('select 1', {}, m);
		expect(violationsFor(result, RULE)).toHaveLength(1);
	});
});
