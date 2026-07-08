import { describe, expect, it } from 'vitest';
import { model, sym, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';

const RULE = 'ninja.aliasing.unused-alias';

function check(m: ReturnType<typeof model>): NinjaViolation[] {
	const result = run('select 1', {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags alias never referenced', () => {
		const orders = sym('table', 'orders', 0, 0, { alias: { name: 'o', line: 0, col: 7 } });
		const alias = sym('alias', 'o', 0, 7, { modifiers: ['declaration'] });
		const col = sym('column', 'id', 0, 15);
		const v = check(model({ symbols: [orders, alias, col] }));
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('o');
	});

	it('no violation when alias is referenced', () => {
		const orders = sym('table', 'orders', 0, 0, { alias: { name: 'o', line: 0, col: 7 } });
		const alias = sym('alias', 'o', 0, 7, { modifiers: ['declaration'] });
		const col = sym('column', 'id', 0, 15, { source: orders });
		expect(check(model({ symbols: [orders, alias, col] }))).toHaveLength(0);
	});

	it('no violation when table has no alias', () => {
		const orders = sym('table', 'orders', 0, 0);
		const col = sym('column', 'id', 0, 15);
		expect(check(model({ symbols: [orders, col] }))).toHaveLength(0);
	});

	it('case insensitive qualifier match', () => {
		const orders = sym('table', 'orders', 0, 0, { alias: { name: 'O', line: 0, col: 7 } });
		const alias = sym('alias', 'O', 0, 7, { modifiers: ['declaration'] });
		const col = sym('column', 'id', 0, 15, { source: orders });
		expect(check(model({ symbols: [orders, alias, col] }))).toHaveLength(0);
	});
});
