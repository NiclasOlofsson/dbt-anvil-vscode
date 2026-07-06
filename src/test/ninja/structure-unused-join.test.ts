import { describe, expect, it } from 'vitest';
import { model, sym, symbolBindings, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import type { Sym } from '../../ftl/sqllens/api';
import type { SymbolBindings } from '../../ftl/sqllens/extract/symbols';

const RULE = 'ninja.structure.unused-join';

function check(symbols: Sym[], bindings: SymbolBindings = symbolBindings()): NinjaViolation[] {
	const m = model({ symbols, symbolBindings: bindings });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags joined table with no column refs', () => {
		const orders = sym('table', 'orders', 0, 0);
		const customers = sym('table', 'customers', 1, 0);
		const oAlias = sym('alias', 'o', 0, 7);
		const cAlias = sym('alias', 'c', 1, 10);
		const idCol = sym('column', 'o.id', 0, 15);

		const v = check(
			[orders, customers, idCol],
			symbolBindings({
				aliasOf: [[orders, oAlias], [customers, cAlias]],
				sourceOf: [[idCol, orders]],
			}),
		);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('customers');
	});

	it('no violation when all tables are referenced', () => {
		const orders = sym('table', 'orders', 0, 0);
		const customers = sym('table', 'customers', 1, 0);
		const oAlias = sym('alias', 'o', 0, 7);
		const cAlias = sym('alias', 'c', 1, 10);
		const idCol = sym('column', 'o.id', 0, 15);
		const nameCol = sym('column', 'c.name', 1, 15);

		const v = check(
			[orders, customers, idCol, nameCol],
			symbolBindings({
				aliasOf: [[orders, oAlias], [customers, cAlias]],
				sourceOf: [[idCol, orders], [nameCol, customers]],
			}),
		);
		expect(v).toHaveLength(0);
	});

	it('no violation with single table', () => {
		const orders = sym('table', 'orders', 0, 0);
		const oAlias = sym('alias', 'o', 0, 7);
		const idCol = sym('column', 'o.id', 0, 15);

		const v = check(
			[orders, idCol],
			symbolBindings({ aliasOf: [[orders, oAlias]], sourceOf: [[idCol, orders]] }),
		);
		expect(v).toHaveLength(0);
	});

	it('uses bare name when no alias', () => {
		const orders = sym('table', 'orders', 0, 0);
		const customers = sym('table', 'customers', 1, 0);
		const idCol = sym('column', 'orders.id', 0, 15);

		const v = check(
			[orders, customers, idCol],
			symbolBindings({ sourceOf: [[idCol, orders]] }),
		);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('customers');
	});

	it('no violation when joined table has no alias and there are unqualified column refs', () => {
		// cte_home_margin is joined without alias; columns appear unqualified
		// → can't determine if they come from this table; must not flag
		const someTable = sym('table', 'some_table', 0, 0);
		const cteHomeMargin = sym('table', 'cte_home_margin', 1, 0); // no alias
		const tAlias = sym('alias', 't', 0, 11);
		const teamCol = sym('column', 't.team', 2, 0);              // qualified ref (some_table)
		const homePtDiffCol = sym('column', 'home_pt_diff', 3, 0);   // unqualified — might be from cte_home_margin

		const v = check(
			[someTable, cteHomeMargin, teamCol, homePtDiffCol],
			symbolBindings({
				aliasOf: [[someTable, tAlias]],
				sourceOf: [[teamCol, someTable]],
			}),
		);
		expect(v).toHaveLength(0);
	});
});
