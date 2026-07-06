import { describe, expect, it } from 'vitest';
import { model, sym, symbolBindings, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import type { Sym } from '../../ftl/sqllens/api';

const RULE = 'ninja.aliasing.unique-table';

/** A FROM/JOIN table-reference Sym plus its optional alias Sym. */
interface Ref { relSym: Sym; aliasSym?: Sym; }

function tableSym(name: string, line: number, col: number, alias?: string, frame?: string): Ref {
	const relSym = sym('table', name, line, col, { frame });
	const aliasSym = alias ? sym('alias', alias, line, col + name.length + 1) : undefined;
	return { relSym, aliasSym };
}

function check(refs: Ref[]): NinjaViolation[] {
	const symbols = refs.map(r => r.relSym);
	const aliasOf: [Sym, Sym][] = refs
		.filter((r): r is Required<Ref> => r.aliasSym !== undefined)
		.map(r => [r.relSym, r.aliasSym]);
	const m = model({ symbols, symbolBindings: symbolBindings({ aliasOf }) });
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags duplicate aliases', () => {
		const v = check([
			tableSym('orders', 0, 0, 'o'),
			tableSym('other', 1, 0, 'o'),
		]);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('o');
	});

	it('no violation for unique aliases', () => {
		expect(check([
			tableSym('orders', 0, 0, 'o'),
			tableSym('customers', 1, 0, 'c'),
		])).toHaveLength(0);
	});

	it('no violation for single table', () => {
		expect(check([tableSym('orders', 0, 0, 'o')])).toHaveLength(0);
	});

	it('flags duplicate bare names (no alias)', () => {
		const v = check([
			tableSym('orders', 0, 0),
			tableSym('orders', 1, 0),
		]);
		expect(v).toHaveLength(1);
	});

	it('case insensitive', () => {
		const v = check([
			tableSym('orders', 0, 0, 'O'),
			tableSym('other', 1, 0, 'o'),
		]);
		expect(v).toHaveLength(1);
	});

	it('flags duplicate aliases within the same CTE scope', () => {
		// Two aliased joins with the same alias inside one CTE body (frame 'cte_a').
		const tokA = tableSym('orders', 2, 5, 'o', 'cte_a');
		const tokB = tableSym('other', 3, 5, 'o', 'cte_a');
		expect(check([tokA, tokB])).toHaveLength(1);
	});
});
