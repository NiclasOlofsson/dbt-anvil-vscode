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

describe('SqllensDocumentParser — column-ref per-part spans (1/2/3-part)', () => {
	// One column per line so line index is stable; `name` is a keyword-role token
	// in sqllens, which the naive identifier-only scan used to mis-pick.
	const SQL = [
		'select',        // 0
		'  bare,',       // 1
		'  a.name,',     // 2
		'  db.sch.col',  // 3
		'from foo as a', // 4
	].join('\n');
	const L = SQL.split('\n');

	it('splits each ref into column + qualifier with exact 0-based spans (endCol exclusive)', async () => {
		const model = await parser().parse(SQL);
		const col = (n: string) =>
			model.tokens.find((t): t is ColumnRefToken => t.type === 'column_ref' && t.name === n)!;

		// 1-part: column only, no qualifier.
		const bare = col('bare');
		expect(bare).toMatchObject({ name: 'bare', line: 1, col: 2, endCol: 6 });
		expect(bare.table).toBeUndefined();

		// 2-part `a.name`: last part is the column, `a` the qualifier.
		const nm = col('name');
		expect(nm).toMatchObject({
			name: 'name', line: 2, col: L[2].indexOf('name'), endCol: L[2].indexOf('name') + 4,
			table: 'a', tableLine: 2, tableCol: L[2].indexOf('a.name'), tableEndCol: L[2].indexOf('a.name') + 1,
		});

		// 3-part `db.sch.col`: qualifier is the part DIRECTLY before the column (`sch`),
		// matching legacy's `Column.table` child — the leading `db` is dropped.
		const c = col('col');
		expect(c).toMatchObject({
			name: 'col', line: 3, col: L[3].indexOf('col'), endCol: L[3].indexOf('col') + 3,
			table: 'sch', tableCol: L[3].indexOf('sch'), tableEndCol: L[3].indexOf('sch') + 3,
		});
	});
});

describe('SqllensDocumentParser — quoted per-part spans (partSpans adoption)', () => {
	// A quoted mixed-case column on an unquoted qualifier. sqllens adopts the IR
	// `partSpans` (one span per dotted part) to place the column-name and qualifier
	// sub-spans. The span QUIRK is inherited from legacy sqlglot: an identifier's
	// span is anchored at `endCol - unquotedName.length`, so a QUOTED part's span
	// drops the opening delimiter (and its first char) and keeps the trailing one.
	// Verified byte-for-byte against FtlDocumentParser: `a.`My Col`` yields the same
	// col=11/endCol=17 there. The residual name-case difference (databricks
	// lowercases a quoted name, snowflake uppercases a table) is `normName`'s domain,
	// not the span logic, and is unchanged by this adoption.
	it('places a backtick-quoted column + unquoted qualifier (databricks)', async () => {
		const sql = 'select a.`My Col` from t as a';
		const model = await parser('databricks').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'My Col',
		)!;
		const q = sql.indexOf('`My Col`');
		expect(col).toMatchObject({
			name: 'My Col',
			line: 0,
			endCol: q + '`My Col`'.length,          // after the closing backtick
			col: q + '`My Col`'.length - 'My Col'.length, // legacy quirk: not the opening backtick
			table: 'a',
			tableCol: sql.indexOf('a.'),
			tableEndCol: sql.indexOf('a.') + 1,
		});
	});

	it('places a bracket-quoted column + unquoted qualifier (tsql)', async () => {
		const sql = 'select a.[My Col] from t as a';
		const model = await parser('tsql').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'My Col',
		)!;
		const q = sql.indexOf('[My Col]');
		expect(col).toMatchObject({
			name: 'My Col',
			endCol: q + '[My Col]'.length,
			col: q + '[My Col]'.length - 'My Col'.length,
			table: 'a',
		});
	});

	it('handles a quoted mixed-case QUALIFIER with a plain column (`"My Table".col`)', async () => {
		// sqllens parses this as qualifier=`My Table`, column=`col` — the structurally
		// correct reading. (Legacy sqlglot mis-parses a quoted qualifier here, treating
		// the quoted part as the column and dropping `.col`; sqllens is more faithful,
		// an accepted divergence, not a span regression.)
		const sql = 'select `My Table`.col from t';
		const model = await parser('databricks').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'col',
		)!;
		const tq = sql.indexOf('`My Table`');
		expect(col).toMatchObject({
			name: 'col',
			col: sql.indexOf('.col') + 1,
			endCol: sql.indexOf('.col') + 1 + 'col'.length,
			table: 'My Table',
			tableEndCol: tq + '`My Table`'.length,
			tableCol: tq + '`My Table`'.length - 'My Table'.length,
		});
	});
});

describe('SqllensDocumentParser — identifier case normalization', () => {
	it('lowercases unquoted identifier names and keeps quoted (backtick) case', async () => {
		// Legacy sqlglot lowercases unquoted identifiers (databricks is case-insensitive)
		// and preserves a quoted identifier's exact case (quotes stripped). Verified
		// against FtlDocumentParser: `Upper_Col` -> `upper_col`, `` `Mixed` `` -> `Mixed`.
		const model = await parser().parse('select Upper_Col, `Mixed`\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'Mixed']);

		const colRefNames = model.tokens
			.filter((t): t is ColumnRefToken => t.type === 'column_ref')
			.map(t => t.name);
		expect(colRefNames).toContain('upper_col');
		expect(colRefNames).toContain('Mixed');
	});
});

describe('SqllensDocumentParser — finalSelect span anchored at first identifier', () => {
	it('anchors a function-wrapped projection at the inner column, not the expression start', async () => {
		// `sum(amount) as total` — legacy anchors the column span at `amount` (the
		// first identifier), NOT the `sum` keyword. The alias sub-span is unchanged.
		const sql = 'select sum(amount) as total\nfrom foo';
		const model = await parser().parse(sql);
		const total = model.finalSelect!.columns.find(c => c.name === 'total')!;

		expect(total.line).toBe(0);
		expect(total.col).toBe('select sum('.length); // start of `amount`, not `sum`
		expect(total.aliasCol).toBe('select sum(amount) as '.length); // start of `total`
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

describe('SqllensDocumentParser — getDialectSymbols', () => {
	// The sets are LOWERCASE: every consumer (cap-keywords/functions/types, the reflow
	// printer) tests membership with `set.has(x.toLowerCase())`, matching the sqlglot
	// path's contract. keywordTokenTypes are sqlglot TokenType NAMES (select, group_by,
	// alias…), NOT keyword words; functions/types come from sqllens's own membership
	// sets, lowercased.
	it('exposes keyword TokenTypes, functions, and types for databricks', async () => {
		const symbols = await parser('databricks').getDialectSymbols();
		expect(symbols).toBeDefined();
		// Compound + single keyword token-type names.
		expect(symbols!.keywordTokenTypes.has('group_by')).toBe(true);
		expect(symbols!.keywordTokenTypes.has('alias')).toBe(true); // the AS keyword
		expect(symbols!.keywordTokenTypes.has('select')).toBe(true);
		// A word mapped to VAR (removed keyword) must NOT be a keyword type.
		expect(symbols!.keywordTokenTypes.has('var')).toBe(false);
		// A known function and type.
		expect(symbols!.functions.has('coalesce')).toBe(true);
		expect(symbols!.types.has('int')).toBe(true);
	});

	it('carries the tsql-specific TOP keyword type and NVARCHAR type', async () => {
		const symbols = await parser('tsql').getDialectSymbols();
		expect(symbols!.keywordTokenTypes.has('top')).toBe(true);
		expect(symbols!.types.has('nvarchar')).toBe(true);
	});

	it('caches per dialect — repeat calls return the identical instance', async () => {
		const p = parser('databricks');
		const a = await p.getDialectSymbols();
		const b = await p.getDialectSymbols();
		expect(a).toBe(b);
		expect(a!.functions).toBe(b!.functions);
		expect(a!.keywordTokenTypes).toBe(b!.keywordTokenTypes);
	});
});
