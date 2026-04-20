import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, applyEditsToText } from './helpers';
import { tableAsRule } from '../../ninja/rules/alias-table-as';
import type { TableRefToken } from '../../services/parse-service';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.aliasing.table-as';

function tableRefTok(
	name: string,
	line: number,
	col: number,
	alias?: string,
	aliasCol?: number,
	aliasEndCol?: number,
	extra: Partial<TableRefToken> = {},
): TableRefToken {
	return {
		type: 'table_ref',
		name,
		line,
		col,
		endCol: col + name.length,
		alias,
		...(alias !== undefined ? {
			aliasLine: line,
			aliasCol: aliasCol ?? col + name.length + 1,
			aliasEndCol: aliasEndCol ?? (aliasCol ?? col + name.length + 1) + alias.length,
		} : {}),
		...extra,
	} as TableRefToken;
}

describe(RULE, () => {
	it('flags alias without AS keyword', () => {
		// "select * from orders o" — orders at col 14, alias 'o' at col 21
		const sql = 'select * from orders o';
		const tok = tableRefTok('orders', 0, 14, 'o', 21, 22);
		const doc = mockDocument(sql);
		const m = model({ tokens: [tok] });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('\'o\'');
	});

	it('no violation when alias uses AS keyword', () => {
		// "select * from orders AS o" — orders at col 14, alias 'o' at col 24
		const sql = 'select * from orders AS o';
		const tok = tableRefTok('orders', 0, 14, 'o', 24, 25);
		const doc = mockDocument(sql);
		const m = model({ tokens: [tok] });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v).toHaveLength(0);
	});

	it('no violation when alias uses lowercase as keyword', () => {
		const sql = 'select * from orders as o';
		const tok = tableRefTok('orders', 0, 14, 'o', 24, 25);
		const doc = mockDocument(sql);
		const m = model({ tokens: [tok] });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v).toHaveLength(0);
	});

	it('autofix inserts AS before alias', () => {
		const sql = 'select * from orders o';
		const tok = tableRefTok('orders', 0, 14, 'o', 21, 22);
		const doc = mockDocument(sql);
		const m = model({ tokens: [tok] });
		const v = tableAsRule.check({ model: m, document: doc, config: cfg() });
		expect(v[0].action?.type).toBe(FixAction.TYPE);
		const fixed = applyEditsToText(sql, (v[0].action as FixAction).ops);
		expect(fixed).toBe('select * from orders AS o');
	});

	it('no violation for table ref without alias', () => {
		const sql = 'select * from orders';
		const tok = tableRefTok('orders', 0, 14);
		const doc = mockDocument(sql);
		const m = model({ tokens: [tok] });
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('skips CTE definition tokens', () => {
		const sql = 'with orders as (select 1)';
		const tok = tableRefTok('orders', 0, 5, 'orders', 5, 11, { cteDefinition: true });
		const doc = mockDocument(sql);
		const m = model({ tokens: [tok] });
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('disabled when explicitAs is false', () => {
		const sql = 'select * from orders o';
		const tok = tableRefTok('orders', 0, 14, 'o', 21, 22);
		const doc = mockDocument(sql);
		const m = model({ tokens: [tok] });
		const c = cfg({ convention: { ...cfg().convention, explicitAs: false } });
		expect(tableAsRule.check({ model: m, document: doc, config: c })).toHaveLength(0);
	});

	it('no violations without tokens', () => {
		const doc = mockDocument('select * from orders o');
		const m = model({});
		expect(tableAsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
