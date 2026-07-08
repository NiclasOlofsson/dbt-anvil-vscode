import { describe, expect, it } from 'vitest';
import { model, sym, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import type { Sym } from '../../ftl/sqllens/api';

const RULE = 'ninja.structure.unused-join';

function check(symbols: Sym[]): NinjaViolation[] {
	const m = model({ symbols });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags joined table with no column refs', () => {
		const orders = sym('table', 'orders', 0, 0, { alias: { name: 'o', line: 0, col: 7 } });
		const customers = sym('table', 'customers', 1, 0, { alias: { name: 'c', line: 1, col: 10 } });
		const idCol = sym('column', 'o.id', 0, 15, { source: orders });

		const v = check([orders, customers, idCol]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('customers');
	});

	it('no violation when all tables are referenced', () => {
		const orders = sym('table', 'orders', 0, 0, { alias: { name: 'o', line: 0, col: 7 } });
		const customers = sym('table', 'customers', 1, 0, { alias: { name: 'c', line: 1, col: 10 } });
		const idCol = sym('column', 'o.id', 0, 15, { source: orders });
		const nameCol = sym('column', 'c.name', 1, 15, { source: customers });

		const v = check([orders, customers, idCol, nameCol]);
		expect(v).toHaveLength(0);
	});

	it('no violation with single table', () => {
		const orders = sym('table', 'orders', 0, 0, { alias: { name: 'o', line: 0, col: 7 } });
		const idCol = sym('column', 'o.id', 0, 15, { source: orders });

		const v = check([orders, idCol]);
		expect(v).toHaveLength(0);
	});

	it('uses bare name when no alias', () => {
		const orders = sym('table', 'orders', 0, 0);
		const customers = sym('table', 'customers', 1, 0);
		const idCol = sym('column', 'orders.id', 0, 15, { source: orders });

		const v = check([orders, customers, idCol]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('customers');
	});

	it('no violation when joined table has no alias and there are unqualified column refs', () => {
		// cte_home_margin is joined without alias; columns appear unqualified
		// → can't determine if they come from this table; must not flag
		const someTable = sym('table', 'some_table', 0, 0, { alias: { name: 't', line: 0, col: 11 } });
		const cteHomeMargin = sym('table', 'cte_home_margin', 1, 0); // no alias
		const teamCol = sym('column', 't.team', 2, 0, { source: someTable });     // qualified ref (some_table)
		const homePtDiffCol = sym('column', 'home_pt_diff', 3, 0);   // unqualified — might be from cte_home_margin

		const v = check([someTable, cteHomeMargin, teamCol, homePtDiffCol]);
		expect(v).toHaveLength(0);
	});
});
