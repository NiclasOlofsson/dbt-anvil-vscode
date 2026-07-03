import { describe, expect, it } from 'vitest';
import { SqllensDocumentParser } from './document-parser';
import type { ColumnRefToken, TableRefToken } from '../../services/parse-service';

function parser(adapterType = 'databricks') {
	return new SqllensDocumentParser({ adapterType });
}

// A realistic dbt model: jinja ref + source, three CTEs, a join, an aggregate.
// Positions are asserted against the source via indexOf so the expectations are
// self-checking rather than hand-counted. blankJinja is length-preserving, so
// SQL-token positions land in raw-source coordinates.
const MODEL = [
	'with orders as (',                                       // 0
	'\tselect o.order_id, o.amount',                          // 1
	'\tfrom {{ ref(\'raw_orders\') }} o',                     // 2
	'),',                                                     // 3
	'customers as (',                                         // 4
	'\tselect c.id, c.name',                                  // 5
	'\tfrom {{ source(\'raw\', \'customers\') }} c',          // 6
	'),',                                                     // 7
	'joined as (',                                            // 8
	'\tselect o.order_id, o.amount, c.name as customer_name', // 9
	'\tfrom orders o',                                        // 10
	'\tjoin customers c on o.order_id = c.id',                // 11
	')',                                                      // 12
	'select customer_name, sum(amount) as total',            // 13
	'from joined',                                            // 14
	'group by customer_name',                                 // 15
].join('\n');

const LINES = MODEL.split('\n');

describe('SqllensDocumentParser — realistic dbt model (databricks)', () => {
	it('extracts CTE names, lines, and output columns', async () => {
		const model = await parser().parse(MODEL);

		expect(model.ctes.map(c => c.name)).toEqual(
			expect.arrayContaining(['orders', 'customers', 'joined']),
		);

		const orders = model.ctes.find(c => c.name === 'orders')!;
		expect(orders.line).toBe(0);
		expect(orders.col).toBe(LINES[0].indexOf('orders'));
		expect(orders.endLine).toBe(3); // the `)` closing the orders body
		expect(orders.columns.map(c => c.name)).toEqual(['order_id', 'amount']);

		const customers = model.ctes.find(c => c.name === 'customers')!;
		expect(customers.columns.map(c => c.name)).toEqual(['id', 'name']);

		const joined = model.ctes.find(c => c.name === 'joined')!;
		expect(joined.columns.map(c => c.name)).toEqual(['order_id', 'amount', 'customer_name']);
	});

	it('extracts jinja refs and sources with spans and back-filled aliases', async () => {
		const model = await parser().parse(MODEL);

		expect(model.refs.map(r => r.model)).toEqual(['raw_orders']);
		const ref = model.refs[0];
		expect(ref.line).toBe(2);
		expect(ref.col).toBe(LINES[2].indexOf('ref(')); // col of the ref() call
		expect(ref.jinjaCol).toBe(LINES[2].indexOf('{{')); // col of the {{ tag
		// enrichTokensWithJinjaSpans back-fills the SQL alias onto the ref.
		expect(ref.alias).toBe('o');

		expect(model.sources.map(s => `${s.sourceName}.${s.tableName}`)).toEqual(['raw.customers']);
		const src = model.sources[0];
		expect(src.line).toBe(6);
		expect(src.alias).toBe('c');
	});

	it('lists the final SELECT output columns', async () => {
		const model = await parser().parse(MODEL);
		expect(model.finalColumns.map(c => c.name)).toEqual(['customer_name', 'total']);

		expect(model.finalSelect).toBeDefined();
		expect(model.finalSelect!.line).toBe(13); // the SELECT keyword line
		expect(model.finalSelect!.col).toBe(0);
		expect(model.finalSelect!.columns.map(c => c.name)).toEqual(['customer_name', 'total']);
		const total = model.finalSelect!.columns.find(c => c.name === 'total')!;
		expect(total.isComplexExpression).toBe(true); // sum(...) — a candidate for aliasing rules
		expect(total.aliasCol).toBe(LINES[13].indexOf('total'));
	});

	it('emits column_ref / table_ref / column_def tokens with resolved links', async () => {
		const model = await parser().parse(MODEL);
		const colRefs = model.tokens.filter((t): t is ColumnRefToken => t.type === 'column_ref');
		const tableRefs = model.tokens.filter((t): t is TableRefToken => t.type === 'table_ref');
		const colDefs = model.tokens.filter(t => t.type === 'column_def');

		// The `AS customer_name` alias in the joined CTE is a column definition site.
		expect(colDefs.some(d => d.name === 'customer_name')).toBe(true);

		// CTE definition sites are marked so aliasing rules skip them.
		expect(tableRefs.some(t => t.name === 'orders' && t.cteDefinition)).toBe(true);

		// The FROM alias `orders o` inside the joined CTE.
		const ordersRef = tableRefs.find(t => t.name === 'orders' && t.alias === 'o');
		expect(ordersRef).toBeDefined();

		// A qualified column `o.order_id` on line 9 resolves to that table_ref, with
		// the column-name sub-span and qualifier sub-span both correct (0-based).
		const oOrderId = colRefs.find(t => t.name === 'order_id' && t.table === 'o' && t.line === 9);
		expect(oOrderId).toBeDefined();
		expect(oOrderId!.col).toBe(LINES[9].indexOf('order_id'));
		expect(oOrderId!.endCol).toBe(LINES[9].indexOf('order_id') + 'order_id'.length);
		expect(oOrderId!.tableCol).toBe(LINES[9].indexOf('o.order_id'));
		expect(oOrderId!.resolvedTableRef).toBe(ordersRef);
	});

	it('parses a clean model on pass1 (isPass2 falsy) and reports timing', async () => {
		const model = await parser().parse(MODEL);
		expect(model.isPass2).toBeFalsy();
		expect(model.sqlglotWarnings).toEqual([]);
		expect(typeof model.timing.totalMs).toBe('number');
		expect(model.ninjaSqlTokens && model.ninjaSqlTokens.length).toBeGreaterThan(0);
		expect(model.jinjaTokens && model.jinjaTokens.length).toBeGreaterThan(0);
		// ast is intentionally absent (reflow AstIndex blocked on sqllens Join nodes).
		expect(model.ast).toBeUndefined();
	});
});

describe('SqllensDocumentParser — parse-failure and cascade paths', () => {
	it('reports syntax_error warnings with 0-based positions for broken SQL', async () => {
		const model = await parser().parse('select a from t )))');
		const errs = (model.sqlglotWarnings ?? []).filter(w => w.type === 'syntax_error');
		expect(errs.length).toBeGreaterThan(0);
		expect(errs[0].line).toBe(0);
		expect(typeof errs[0].col).toBe('number');
		expect(errs[0].endCol).toBeGreaterThan(errs[0].col!);
	});

	it('falls through to pass2 when a statement-level macro breaks every blank', async () => {
		// The macro sits between two full statements: identifier-mode (pass1) and
		// comment-mode (pass1b) blanking both leave invalid SQL, so only the
		// nunjucks render (pass2) yields a parse — which sets isPass2.
		const sql = 'select a from t\n{{ some_statement_macro() }}\nselect b from u';
		const model = await parser().parse(sql);
		expect(model.isPass2).toBe(true);
	});
});

describe('SqllensDocumentParser — dialect smoke', () => {
	it('parses a simple model under tsql', async () => {
		const model = await parser('tsql').parse('select a, b from t');
		expect(model.finalColumns.map(c => c.name)).toEqual(['a', 'b']);
		expect(model.tokens.some(t => t.type === 'table_ref' && t.name === 't')).toBe(true);
		expect(model.sqlglotWarnings).toEqual([]);
	});

	it('parses a simple model under snowflake', async () => {
		const model = await parser('snowflake').parse('select a, b from t');
		expect(model.finalColumns.map(c => c.name)).toEqual(['a', 'b']);
		expect(model.tokens.some(t => t.type === 'table_ref' && t.name === 't')).toBe(true);
		expect(model.sqlglotWarnings).toEqual([]);
	});
});
