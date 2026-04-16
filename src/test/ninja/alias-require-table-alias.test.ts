import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, tableRef } from './helpers';
import { requireTableAliasRule } from '../../ninja/rules/alias-require-table-alias';

const RULE = 'ninja.aliasing.require-table-alias';

function check(sql: string, m: ReturnType<typeof model>) {
	const doc = mockDocument(sql);
	return requireTableAliasRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation with single table (no alias needed)', () => {
		const sql = 'select * from orders';
		const m = model({ tokens: [tableRef('orders', 0, 14)] });
		expect(check(sql, m)).toHaveLength(0);
	});

	it('no violation when all tables have aliases', () => {
		const sql = 'select * from orders o join items i on o.id = i.order_id';
		const m = model({
			tokens: [
				tableRef('orders', 0, 14, 'o'),
				tableRef('items', 0, 30, 'i'),
			],
		});
		expect(check(sql, m)).toHaveLength(0);
	});

	it('flags unaliased table when multiple sources', () => {
		const sql = 'select * from orders join items i on orders.id = i.order_id';
		const m = model({
			tokens: [
				tableRef('orders', 0, 14),
				tableRef('items', 0, 28, 'i'),
			],
		});
		const v = check(sql, m);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('orders');
		expect(v[0].message).toContain('alias');
	});

	it('flags multiple unaliased tables', () => {
		const sql = 'select * from orders join items on orders.id = items.order_id';
		const m = model({
			tokens: [
				tableRef('orders', 0, 14),
				tableRef('items', 0, 28),
			],
		});
		expect(check(sql, m)).toHaveLength(2);
	});

	it('no violations with zero table sources', () => {
		const sql = 'select 1';
		expect(check(sql, model())).toHaveLength(0);
	});

	it('range points to table ref position', () => {
		const sql = 'select * from orders join items i on 1=1';
		const m = model({
			tokens: [
				tableRef('orders', 0, 14),
				tableRef('items', 0, 28, 'i'),
			],
		});
		const v = check(sql, m);
		expect(v[0].range.start.line).toBe(0);
		expect(v[0].range.start.character).toBe(14);
		expect(v[0].range.end.character).toBe(20); // 14 + 'orders'.length
	});

	it('no fix is provided', () => {
		const sql = 'select * from orders join items i on 1=1';
		const m = model({
			tokens: [
				tableRef('orders', 0, 14),
				tableRef('items', 0, 28, 'i'),
			],
		});
		const v = check(sql, m);
		expect(v[0].action).toBeUndefined();
	});
});
