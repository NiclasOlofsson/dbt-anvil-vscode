import { describe, expect, it } from 'vitest';
import { parse, resolveScopes, Schema, MAIN_FRAME } from '../../../../ftl/sqllens/api';
import { extractSymbols } from '../../../../ftl/sqllens/extract/symbols';
import type { Dialect, Sym } from '../../../../ftl/sqllens/api';

function run(sql: string, dialect: Dialect = 'databricks'): Sym[] {
	const { ast } = parse(sql, dialect);
	const scopes = resolveScopes(ast, dialect);
	const schema = new Schema({});
	return extractSymbols(scopes, dialect, schema);
}

const byName = (symbols: Sym[], kind: Sym['kind'], name: string): Sym =>
	symbols.find(s => s.kind === kind && s.name.toLowerCase() === name.toLowerCase())!;

describe('extractSymbols — relation/alias pairing (Sym.alias, native)', () => {
	it('pairs a table source with its alias', () => {
		const symbols = run('select o.id from orders o');
		const table = byName(symbols, 'table', 'orders');
		expect(table.alias).toBeDefined();
		expect(table.alias!.name).toBe('o');
	});

	it('leaves an unaliased table with no alias', () => {
		const symbols = run('select id from orders');
		const table = byName(symbols, 'table', 'orders');
		expect(table.alias).toBeUndefined();
	});

	it('pairs a CTE reference (not the CTE declaration) with its alias', () => {
		const symbols = run('with c as (select 1 as id) select x.id from c x');
		// Two 'cte' kind syms: the declaration (modifiers: declaration) and the
		// FROM-clause reference (modifiers: reference) — only the reference gets an alias.
		const declaration = symbols.find(s => s.kind === 'cte' && s.modifiers.includes('declaration'))!;
		const reference = symbols.find(s => s.kind === 'cte' && s.modifiers.includes('reference'))!;
		expect(declaration.alias).toBeUndefined();
		expect(reference.alias?.name).toBe('x');
	});

	it('pairs each table independently across a two-table join, no cross-contamination', () => {
		const symbols = run('select o.id, c.name from orders o join customers c on o.cid = c.id');
		const orders = byName(symbols, 'table', 'orders');
		const customers = byName(symbols, 'table', 'customers');
		expect(orders.alias?.name).toBe('o');
		expect(customers.alias?.name).toBe('c');
	});

	it('pairs a subquery source with its alias, and the subquery body gets its own frame', () => {
		const symbols = run('select s.id from (select id from orders) s');
		const subquery = symbols.find(s => s.kind === 'subquery' && s.modifiers.includes('reference'))!;
		expect(subquery.alias?.name).toBe('s');
		// The inner `id` column reference lives in frame "s" (the subquery's alias),
		// not MAIN_FRAME — confirms frame partitioning tracked the subquery recursion.
		const innerColumn = symbols.find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.frame === 's');
		expect(innerColumn).toBeDefined();
	});
});

describe('extractSymbols — column-source binding (Sym.source, native)', () => {
	it('resolves a qualified column to its aliased table', () => {
		const symbols = run('select o.id from orders o');
		const table = byName(symbols, 'table', 'orders');
		const column = symbols.find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'o.id')!;
		expect(column.source).toBe(table);
	});

	it('resolves a bare column to the sole FROM source', () => {
		const symbols = run('select id from orders o');
		const table = byName(symbols, 'table', 'orders');
		const column = symbols.find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'id')!;
		expect(column.source).toBe(table);
	});

	it('resolves each side of a join to the correct table, not just the first', () => {
		const symbols = run('select o.id, c.name from orders o join customers c on o.cid = c.id');
		const orders = byName(symbols, 'table', 'orders');
		const customers = byName(symbols, 'table', 'customers');
		const oId = symbols.find(s => s.kind === 'column' && s.name === 'o.id')!;
		const cName = symbols.find(s => s.kind === 'column' && s.name === 'c.name')!;
		expect(oId.source).toBe(orders);
		expect(cName.source).toBe(customers);
	});

	it('resolves a CTE reference column to the CTE reference sym, not its declaration', () => {
		const symbols = run('with c as (select 1 as id) select x.id from c x');
		const reference = symbols.find(s => s.kind === 'cte' && s.modifiers.includes('reference'))!;
		const column = symbols.find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'x.id')!;
		expect(column.source).toBe(reference);
	});
});

describe('extractSymbols — frame partitioning matches sqllens', () => {
	it('the main query frame is MAIN_FRAME', () => {
		const symbols = run('select id from orders');
		expect(symbols.some(s => s.frame === MAIN_FRAME)).toBe(true);
	});

	it('a CTE body is its own frame, distinct from MAIN_FRAME', () => {
		const symbols = run('with c as (select id from orders) select id from c');
		const inner = symbols.find(s => s.kind === 'column' && s.name === 'id' && s.frame !== MAIN_FRAME);
		expect(inner?.frame).toBe('c');
	});
});
