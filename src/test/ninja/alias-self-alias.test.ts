import { describe, expect, it } from 'vitest';
import { model, sym, symbolBindings, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import type { Sym } from '../../ftl/sqllens/api';

const RULE = 'ninja.aliasing.self-alias';

function check(relSym: Sym, aliasSym?: Sym): NinjaViolation[] {
	const symbols = aliasSym ? [relSym, aliasSym] : [relSym];
	const bindings = symbolBindings({ aliasOf: aliasSym ? [[relSym, aliasSym]] : [] });
	const m = model({ symbols, symbolBindings: bindings });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags table aliased to its own name', () => {
		const tableSym = sym('table', 'orders', 0, 0);
		const aliasSym = sym('alias', 'orders', 0, 7, { modifiers: ['declaration'] });
		const v = check(tableSym, aliasSym);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('orders');
		expect(v[0].action).toBeDefined();
	});

	it('ignores table aliased to different name', () => {
		const tableSym = sym('table', 'orders', 0, 0);
		const aliasSym = sym('alias', 'o', 0, 7, { modifiers: ['declaration'] });
		expect(check(tableSym, aliasSym)).toHaveLength(0);
	});

	it('ignores table with no alias', () => {
		const tableSym = sym('table', 'orders', 0, 0);
		expect(check(tableSym)).toHaveLength(0);
	});

	it('case insensitive comparison', () => {
		const tableSym = sym('table', 'Orders', 0, 0);
		const aliasSym = sym('alias', 'ORDERS', 0, 7, { modifiers: ['declaration'] });
		const v = check(tableSym, aliasSym);
		expect(v).toHaveLength(1);
	});

	it('ignores subquery alias — (...) AS po has name=alias but kind is subquery, not table/cte', () => {
		// A subquery source's relation Sym has kind 'subquery', not 'table'/'cte' — there
		// is no underlying table being renamed, so self-alias checks must never fire on it.
		const subquerySym = sym('subquery', 'po', 5, 5);
		const aliasSym = sym('alias', 'po', 5, 8, { modifiers: ['declaration'] });
		expect(check(subquerySym, aliasSym)).toHaveLength(0);
	});
});
