import { describe, expect, it } from 'vitest';
import { SqllensDocumentParser } from '../../../ftl/sqllens/document-parser';
import { makeTemplateProvider } from '../../../ftl/sqllens/template-shape';
import { decompose } from '../../../ftl/sqllens/decompose';
import { traceColumnLineage } from '../../../ftl/sqllens/lineage';
import { buildStarExpander } from '../../../ftl/sqllens/extract/star-expand';
import { Schema, type ScopeTree, type Sym } from '../../../ftl/sqllens/api';
import { isRelationSym, nameRangeOf, qualifierRangeOf, rangeOfSpan } from '../../../providers/sql/sym-spans';

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

	it('parses a clean model and reports timing', async () => {
		const model = await parser().parse(MODEL);
		expect(model.parseWarnings).toEqual([]);
		expect(typeof model.timing.totalMs).toBe('number');
		expect(model.ninjaSqlTokens && model.ninjaSqlTokens.length).toBeGreaterThan(0);
		expect(model.jinjaTokens && model.jinjaTokens.length).toBeGreaterThan(0);
	});
});

describe('SqllensDocumentParser — Sym wave 2: symbols wired end-to-end', () => {
	it('populates model.symbols with resolved links', async () => {
		const model = await parser().parse(MODEL);
		expect(model.symbols).toBeDefined();
		expect(model.symbols!.length).toBeGreaterThan(0);

		// The `AS customer_name` alias in the joined CTE is a column declaration site.
		expect(model.symbols!.some(s => s.kind === 'column' && s.modifiers.includes('declaration') && s.name === 'customer_name')).toBe(true);

		// CTE declaration sites are marked so aliasing rules skip them.
		expect(model.symbols!.some(s => s.kind === 'cte' && s.modifiers.includes('declaration') && s.name === 'orders')).toBe(true);

		// The `orders` CTE reference in the `joined` CTE's FROM clause resolves its alias `o`.
		const ordersRef = model.symbols!.find(s => s.kind === 'cte' && s.modifiers.includes('reference') && s.name === 'orders')!;
		expect(ordersRef).toBeDefined();
		expect(ordersRef.alias?.name).toBe('o');

		// `o.order_id` appears twice (once inside the `orders` CTE's own body, aliasing
		// the ref() source; once inside `joined`, aliasing the `orders` CTE reference
		// this test is about) — disambiguate by frame.
		const oOrderId = model.symbols!.find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name === 'o.order_id' && s.frame === 'joined');
		expect(oOrderId).toBeDefined();
		expect(oOrderId!.source).toBe(ordersRef);

		// The column-name sub-span and qualifier sub-span are both correct (0-based).
		const nameRange = nameRangeOf(oOrderId!);
		expect(nameRange.start.line).toBe(9);
		expect(nameRange.start.character).toBe(LINES[9].indexOf('order_id'));
		expect(nameRange.end.character).toBe(LINES[9].indexOf('order_id') + 'order_id'.length);
		const qualRange = qualifierRangeOf(oOrderId!);
		expect(qualRange!.start.character).toBe(LINES[9].indexOf('o.order_id'));
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
			(model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name.split('.').pop() === n)!;
		const resolvedAlias = (sym: Sym) => sym.source?.alias?.name;

		// 1-part bare column: no qualifier IN SOURCE, but qualify binds it to the single FROM
		// source `foo as a` — the qualifier resolves bare `bare` to the source alias `a`.
		// So the resolved alias is `a` (consumed from Qualification.bindingOf), with NO
		// qualifier sub-span since there's no written qualifier to point at.
		const bare = col('bare');
		const bareRange = nameRangeOf(bare);
		expect(bareRange.start.line).toBe(1);
		expect(bareRange.start.character).toBe(2);
		expect(bareRange.end.character).toBe(6);
		expect(resolvedAlias(bare)).toBe('a');
		expect(qualifierRangeOf(bare)).toBeUndefined();

		// 2-part `a.name`: last part is the column, `a` the qualifier.
		const nm = col('name');
		const nmRange = nameRangeOf(nm);
		expect(nmRange.start.line).toBe(2);
		expect(nmRange.start.character).toBe(L[2].indexOf('name'));
		expect(nmRange.end.character).toBe(L[2].indexOf('name') + 4);
		const nmQual = qualifierRangeOf(nm)!;
		expect(nmQual.start.line).toBe(2);
		expect(nmQual.start.character).toBe(L[2].indexOf('a.name'));
		expect(nmQual.end.character).toBe(L[2].indexOf('a.name') + 1);
		expect(resolvedAlias(nm)).toBe('a');

		// 3-part `db.sch.col`: the WRITTEN qualifier text/span is still `sch` (the part
		// directly before the column). But `sch` names no real FROM/JOIN source in this
		// scope (only `foo as a` is), so sqllens's own splitColumnRef (src/scope/scope.ts:
		// 118-136) correctly falls through to the unqualified reading — `db` becomes the
		// "column" with `.sch.col` as a struct-field path — and `bindingOf` resolves it to
		// the sole ambient source, same as the bare `bare` case above. The RESOLVED alias
		// reflects that resolution (`a`), not the fictional written qualifier; the
		// qualifier's own span still points at `sch`.
		const c = col('col');
		const cRange = nameRangeOf(c);
		expect(cRange.start.line).toBe(3);
		expect(cRange.start.character).toBe(L[3].indexOf('col'));
		expect(cRange.end.character).toBe(L[3].indexOf('col') + 3);
		const cQual = qualifierRangeOf(c)!;
		expect(cQual.start.character).toBe(L[3].indexOf('sch'));
		expect(cQual.end.character).toBe(L[3].indexOf('sch') + 3);
		expect(resolvedAlias(c)).toBe('a');
	});
});

describe('SqllensDocumentParser — quoted per-part spans (partSpans adoption)', () => {
	// A quoted mixed-case column on an unquoted qualifier. sqllens adopts the IR
	// `partSpans` (one span per dotted part) to place the column-name and qualifier
	// sub-spans. Each sub-span covers the WHOLE raw source token including its
	// delimiters: a quoted part starts at its opening delimiter and ends just past
	// its closing one. The NAME (`Sym.name`, sqllens's `displayName`) strips the
	// quoting delimiters but never changes case, regardless of dialect — that's
	// `normName`'s domain (a different extractor, `model.finalColumns`), not
	// `displayName`'s, and neither one moves the span.
	it('places a backtick-quoted column + unquoted qualifier (databricks)', async () => {
		const sql = 'select a.`My Col` from t as a';
		const model = await parser('databricks').parse(sql);
		const col = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name.split('.').pop() === 'My Col')!;
		const q = sql.indexOf('`My Col`');
		const range = nameRangeOf(col);
		expect(range.start.line).toBe(0);
		expect(range.start.character).toBe(q); // the opening backtick
		expect(range.end.character).toBe(q + '`My Col`'.length); // just past the closing backtick
		const qualRange = qualifierRangeOf(col)!;
		expect(qualRange.start.character).toBe(sql.indexOf('a.'));
		expect(qualRange.end.character).toBe(sql.indexOf('a.') + 1);
		expect(col.source?.alias?.name).toBe('a');
	});

	it('places a bracket-quoted column + unquoted qualifier (tsql)', async () => {
		const sql = 'select a.[My Col] from t as a';
		const model = await parser('tsql').parse(sql);
		const col = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name.split('.').pop() === 'My Col')!;
		const q = sql.indexOf('[My Col]');
		const range = nameRangeOf(col);
		expect(range.start.character).toBe(q);
		expect(range.end.character).toBe(q + '[My Col]'.length);
		expect(col.source?.alias?.name).toBe('a');
	});

	it('handles a quoted mixed-case QUALIFIER with a plain column (`"My Table".col`)', async () => {
		// sqllens parses this as qualifier=`My Table`, column=`col` — the structurally
		// correct reading. (The legacy parser mis-parses a quoted qualifier here, treating
		// the quoted part as the column and dropping `.col`; sqllens is more faithful,
		// an accepted divergence, not a span regression.)
		// The FROM clause is bare `t` (no alias, and `` `My Table` `` names no real source),
		// so sqllens's splitColumnRef falls through to the unqualified reading and
		// `bindingOf` resolves the reference to the actual source `t` — same mechanism as
		// the 3-part-qualifier case above. The RESOLVED source reflects that resolution; the
		// qualifier's own span still points at the written `` `My Table` ``.
		const sql = 'select `My Table`.col from t';
		const model = await parser('databricks').parse(sql);
		const col = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('reference') && s.name.split('.').pop() === 'col')!;
		const tq = sql.indexOf('`My Table`');
		const range = nameRangeOf(col);
		expect(range.start.character).toBe(sql.indexOf('.col') + 1);
		expect(range.end.character).toBe(sql.indexOf('.col') + 1 + 'col'.length);
		const qualRange = qualifierRangeOf(col)!;
		expect(qualRange.start.character).toBe(tq);
		expect(qualRange.end.character).toBe(tq + '`My Table`'.length);
		expect(col.source?.name).toBe('t');
	});
});

describe('SqllensDocumentParser — dialect-aware identifier case normalization', () => {
	// `model.finalColumns` (this extension's own `extractFinalColumns`) folds through
	// `normName`/`foldIdentifier` for dialect-aware casing (vendor-doc-verified per-dialect
	// fold). Three strategies span the eight sqllens dialects:
	//   - CASE_INSENSITIVE (databricks/tsql/bigquery/redshift/duckdb/trino): everything
	//     lowercased, quoted included — except bigquery TABLE names, which preserve
	//     case (`kind: 'table'`; tables are case-sensitive there, columns are not).
	//   - UPPERCASE (snowflake): unquoted uppercased, quoted preserved.
	//   - LOWERCASE (postgres): unquoted lowercased, quoted preserved.
	//
	// `model.symbols` (sqllens's own `deriveSymbols`) does NOT go through this fold at
	// all — `Sym.name` is sqllens's `displayName`, which only strips quoting delimiters
	// and never changes case, regardless of dialect (verified empirically; `displayName`'s
	// own doc comment: "never use this for comparison" — precisely because it carries no
	// dialect-fold guarantee). So `colRefNames` below always shows the RAW/declared
	// spelling, unlike `model.finalColumns`.

	const colRefNames = (model: { symbols?: readonly Sym[] }): string[] =>
		(model.symbols ?? [])
			.filter(s => s.kind === 'column' && s.modifiers.includes('reference'))
			.map(s => s.name);

	it('databricks: finalColumns unquoted/backtick-quoted lowercased; Sym.name preserves the declared spelling', async () => {
		const model = await parser('databricks').parse('select Upper_Col, `Mixed`\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'mixed']);
		expect(colRefNames(model)).toEqual(expect.arrayContaining(['Upper_Col', 'Mixed']));
	});

	it('tsql: unquoted lowercased, bracket-quoted lowercased', async () => {
		const model = await parser('tsql').parse('select Upper_Col, [Mixed]\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'mixed']);
	});

	it('duckdb: unquoted lowercased, double-quoted lowercased (case-insensitive)', async () => {
		const model = await parser('duckdb').parse('select Upper_Col, "Mixed"\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'mixed']);
	});

	it('snowflake: finalColumns unquoted UPPERCASED/double-quoted preserved; Sym.name preserves the declared spelling', async () => {
		const model = await parser('snowflake').parse('select Upper_Col, "Mixed"\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['UPPER_COL', 'Mixed']);
		expect(colRefNames(model)).toEqual(expect.arrayContaining(['Upper_Col', 'Mixed']));
	});

	it('postgres: unquoted lowercased, double-quoted preserved', async () => {
		const model = await parser('postgres').parse('select Upper_Col, "Mixed"\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'Mixed']);
	});

	it('bigquery: finalColumns/ctes fold table names case-preserved, columns/CTE names lowercase; Sym.name always preserves the declared spelling', async () => {
		const model = await parser('bigquery').parse(
			'with MyCte as (select mycol from MyTable)\nselect mycol from MyCte',
		);
		const tableRef = (model.symbols ?? []).find(s => s.kind === 'table' && s.modifiers.includes('reference') && s.name === 'MyTable');
		expect(tableRef).toBeDefined();
		const cteDef = (model.symbols ?? []).find(s => s.kind === 'cte' && s.modifiers.includes('declaration'));
		expect(cteDef?.name).toBe('MyCte'); // Sym.name: declared spelling, not normName-folded
		expect(model.ctes.map(c => c.name)).toContain('mycte'); // CteInfo.name: normName-folded
		expect(colRefNames(model)).toEqual(expect.arrayContaining(['mycol']));
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

describe('SqllensDocumentParser — alias spans via Projection.aliasCst (ITEM 5)', () => {
	// The two shapes the old cst.stop heuristic misread, pinned upstream in sqllens
	// tests/ir.alias-span.test.ts (e6078d7) and consumed here.
	it('anchors the alias after a trailing line comment on the projection', async () => {
		const sql = 'select a + b as x -- note\nfrom t';
		const model = await parser().parse(sql);
		const def = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('declaration') && s.name === 'x')!;
		const range = nameRangeOf(def);
		expect(range.start.line).toBe(0);
		expect(range.start.character).toBe('select a + b as '.length); // `x`, not the comment token
		expect(range.end.character).toBe('select a + b as x'.length);

		const col = model.finalSelect!.columns.find(c => c.name === 'x')!;
		expect(col.aliasCol).toBe('select a + b as '.length);
		expect(col.aliasEndCol).toBe('select a + b as x'.length);
	});

	it('anchors the alias of a parenthesized expression projection', async () => {
		const sql = 'select (a+b) as x from t';
		const model = await parser().parse(sql);
		const def = (model.symbols ?? []).find(s => s.kind === 'column' && s.modifiers.includes('declaration') && s.name === 'x')!;
		const range = nameRangeOf(def);
		expect(range.start.character).toBe('select (a+b) as '.length);
		expect(range.end.character).toBe('select (a+b) as x'.length);
	});
});

describe('SqllensDocumentParser — parse-failure paths', () => {
	it('reports syntax_error warnings with 0-based positions for broken SQL', async () => {
		const model = await parser().parse('select a from t )))');
		const errs = (model.parseWarnings ?? []).filter(w => w.type === 'syntax_error');
		expect(errs.length).toBeGreaterThan(0);
		expect(errs[0].line).toBe(0);
		expect(typeof errs[0].col).toBe('number');
		expect(errs[0].endCol).toBeGreaterThan(errs[0].col!);
	});

	it('parses a trailing-conjunct macro cleanly when the provider classifies it (conjunct shape)', async () => {
		// A production soft-delete macro family: an `and …` conjunct appended after
		// a complete ON expression, before UNION ALL. With the macro's source bound
		// via the provider, classifyMacroShape answers 'conjunct' and sqllens fills
		// `AND 1=1` — restoring the full-parse assertions the cascade's comment-
		// blank rescue used to provide (and better: the query structure survives).
		const templateProvider = makeTemplateProvider(name =>
			name === 'generic_is_deleted'
				? '{% macro generic_is_deleted(column) %}and {{ column }} = false{% endmacro %}'
				: undefined,
		);
		const sql = [
			'with warehouse as (',                                   // 0
			'    select',                                            // 1
			'        wh.mkey,',                                      // 2
			'        ss.sourcename',                                 // 3
			'    from gold__warehouse wh',                           // 4
			'    left join gold__sourcesystem ss',                   // 5
			'        on ss.sourcename = wh.sourcesystembkey',        // 6
			'    {{ generic_is_deleted(wh.is_deleted) }}',           // 7
			'    union all',                                         // 8
			'    select',                                            // 9
			'        wh2.mkey,',                                     // 10
			'        ss2.sourcename',                                // 11
			'    from gold__warehouse2 wh2',                         // 12
			'    left join gold__sourcesystem ss2',                  // 13
			'        on ss2.sourcename = wh2.sourcesystembkey',      // 14
			'    {{ generic_is_deleted(wh2.is_deleted) }}',          // 15
			')',                                                     // 16
			'select mkey, sourcename from warehouse',                // 17
		].join('\n');
		const model = await new SqllensDocumentParser({ adapterType: 'databricks', templateProvider }).parse(sql);
		expect(model.parseWarnings ?? []).toEqual([]);
		expect(model.ctes).toHaveLength(1);
		expect(model.ctes[0].name).toBe('warehouse');
		expect(model.ctes[0].line).toBe(0);
		const cols = model.ctes[0].columns;
		expect(cols.find(c => c.name === 'mkey')?.line).toBe(2);
		expect(cols.find(c => c.name === 'sourcename')?.line).toBe(3);
	});

	// The real generic_is_deleted signature takes the mode as a PARAMETER —
	// `{{ stat }} {{ column_name }}=false` — so the body alone classifies as
	// nothing and the tag gets the identifier fill, which is a syntax error
	// after a complete ON predicate (gold__vendor.sql, F5 smoke finding).
	const MODE_ARG_PROVIDER = makeTemplateProvider(name =>
		name === 'generic_is_deleted'
			? '{% macro generic_is_deleted(column_name,stat) %}\n    {{ stat }} {{ column_name }}=false\n{% endmacro %}'
			: undefined,
	);

	it('parses an and-mode macro whose mode arrives as a call argument', async () => {
		const sql = [
			'select ve.vendorkey',
			'from gold__vendor ve',
			'left outer join gold__chain ca',
			'    on (ve.chainkey = ca.chainkey and ca.gold_sourcesystemkey=\'d365\')',
			'{{ generic_is_deleted(\'ve.is_deleted\',\'and\') }}',
		].join('\n');
		const model = await new SqllensDocumentParser({ adapterType: 'databricks', templateProvider: MODE_ARG_PROVIDER }).parse(sql);
		expect((model.parseWarnings ?? []).filter(w => w.type === 'syntax_error')).toEqual([]);
	});

	// The where-mode slot from gold__vendor.sql — after a complete ON
	// predicate, before UNION ALL. The where-clause shape (sqllens a269062)
	// fills WHERE 1=1, valid here and in the `from t {{ m('where') }}` slot.
	it('parses a where-mode macro after a complete ON predicate', async () => {
		const sql = [
			'select ve.vendorkey',
			'from gold__vendor ve',
			'left outer join gold__chain ca',
			'    on (ve.chainkey = ca.chainkey and ca.gold_sourcesystemkey=\'d365\')',
			'{{ generic_is_deleted(\'ve.is_deleted\',\'where\') }}',
			'union all',
			'select \'-1\' as vendorkey',
		].join('\n');
		const model = await new SqllensDocumentParser({ adapterType: 'databricks', templateProvider: MODE_ARG_PROVIDER }).parse(sql);
		expect((model.parseWarnings ?? []).filter(w => w.type === 'syntax_error')).toEqual([]);
	});

	// A syntax-error MESSAGE must quote raw source, never the placeholder fill
	// ("mismatched input 'jjjj…'" leaked mask text the user never wrote).
	// Provider-less unknown macro, so this holds independently of shape
	// classification (sqllens a269062 shipped the both-surfaces scrub).
	it('never quotes placeholder fill text in a syntax-error message', async () => {
		const sql = [
			'select a',
			'from t',
			'join u on (t.a = u.a)',
			'{{ some_unknown_macro(\'t.x\',\'where\') }}',
			'union all',
			'select b from v',
		].join('\n');
		const model = await parser().parse(sql);
		const msgs = (model.parseWarnings ?? []).map(w => w.message).join('\n');
		expect(msgs).not.toMatch(/j{4,}/);
	});

	it('yields an error-tolerant partial model for an unshaped statement-level macro', async () => {
		// The macro sits between two full statements and no provider macro knowledge is bound, so the
		// identifier fill leaves invalid SQL. There is no render pass anymore: the
		// partial parse IS the result — raw coordinates, syntax
		// errors surfaced as warnings, and the tag-AST still delivers the macro call.
		const sql = 'select a from t\n{{ some_statement_macro() }}\nselect b from u';
		const model = await parser().parse(sql);
		expect((model.parseWarnings ?? []).some(w => w.type === 'syntax_error')).toBe(true);
		expect((model.macroCalls ?? []).map(m => m.name)).toContain('some_statement_macro');
		// Statement 1 parsed — its table ref survives in the token stream.
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 't')).toBe(true);
	});
});

describe('SqllensDocumentParser — dialect smoke', () => {
	it('parses a simple model under tsql', async () => {
		const model = await parser('tsql').parse('select a, b from t');
		expect(model.finalColumns.map(c => c.name)).toEqual(['a', 'b']);
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 't')).toBe(true);
		expect(model.parseWarnings).toEqual([]);
	});

	it('parses a simple model under snowflake', async () => {
		// snowflake's NORMALIZATION_STRATEGY is UPPERCASE — finalColumns (normName-folded)
		// uppercases unquoted identifiers per Snowflake's convention; Sym.name (sqllens's
		// displayName) is never folded, so it preserves the declared spelling ('t') as
		// literally written, regardless of dialect.
		const model = await parser('snowflake').parse('select a, b from t');
		expect(model.finalColumns.map(c => c.name)).toEqual(['A', 'B']);
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 't')).toBe(true);
		expect(model.parseWarnings).toEqual([]);
	});
});

describe('SqllensDocumentParser — schema-fed SELECT * expansion', () => {
	// A 2-level `{ table: { column: type } }` map — the exact shape ParseService builds
	// from the manifest indexer + describe cache, assignable directly to sqllens Schema.
	const T_SCHEMA = { t: { aa: 'int', bb: 'string' } };

	it('expands a top-level `select * from t` into the schema columns, anchored star-exact', async () => {
		const sql = 'select * from t';
		const model = await parser('databricks').parse(sql, { schema: T_SCHEMA });

		expect(model.finalColumns.map(c => c.name)).toEqual(['aa', 'bb']);
		// Every expanded column anchors on the `*` CHARACTER: [starCol, starCol+1).
		// (The anchoring decision — a highlight covers the star, never positions
		// synthesized via legacy's `endCol - name.length`.)
		const starCol = sql.indexOf('*');
		expect(model.finalColumns.find(c => c.name === 'aa')!.col).toBe(starCol);
		expect(model.finalColumns.find(c => c.name === 'bb')!.col).toBe(starCol);

		// finalSelect columns carry the qualified source (`t.aa`) as table + expression.
		const fs = model.finalSelect!.columns;
		expect(fs.map(c => c.name)).toEqual(['aa', 'bb']);
		expect(fs.every(c => c.table === 't')).toBe(true);
		expect(fs.every(c => c.col === starCol && c.endCol === starCol + 1)).toBe(true);
		expect(fs.find(c => c.name === 'aa')!.expression).toBe('aa');
	});

	it('anchors a qualified `t.*` expansion on the `*` character, not the qualifier', async () => {
		const sql = 'select t.* from t';
		const model = await parser('databricks').parse(sql, { schema: T_SCHEMA });
		const starCol = sql.indexOf('*');
		expect(model.finalColumns.map(c => c.name)).toEqual(['aa', 'bb']);
		expect(model.finalColumns.every(c => c.col === starCol)).toBe(true);
	});

	it('expands a CTE-chain wildcard by inference once a schema is supplied for the base table', async () => {
		// A schema only for the base `t` is enough — every CTE in the chain infers
		// its columns from it, INCLUDING the pure `select *` CTE `b`. The legacy
		// engine kept a literal `*` sentinel for a sole-bare-star CTE (wildcardCtes
		// side-channel — a limitation, not intent); the union-view pipeline resolves
		// the chain, and every `*`-sentinel consumer is equal-or-better with real
		// columns: unknown-column validation engages instead of skipping, hover
		// matches truthfully instead of matching anything, completions offer real
		// names. (Contract change adopted with the variant wave, 2026-07-10 —
		// same class as the schema-resolved-star lineage edges.)
		const sql = 'with a as (select x, y from t),\nb as (select * from a)\nselect * from b';
		const model = await parser('databricks').parse(sql, { schema: { t: { x: 'int', y: 'int' } } });

		expect(model.finalColumns.map(c => c.name)).toEqual(['x', 'y']);
		expect(model.ctes.find(c => c.name === 'a')!.columns.map(c => c.name)).toEqual(['x', 'y']);
		expect(model.ctes.find(c => c.name === 'b')!.columns.map(c => c.name)).toEqual(['x', 'y']);
	});

	it('expands a mixed `*, extra` CTE body (not a sole bare star) into real columns', async () => {
		const sql = 'with a as (select x, y from t),\nb as (select *, 1 as extra from a)\nselect extra from b';
		const model = await parser('databricks').parse(sql, { schema: { t: { x: 'int', y: 'int' } } });
		// b is NOT a pure `select *` → legacy expands it; sqllens must too.
		expect(model.ctes.find(c => c.name === 'b')!.columns.map(c => c.name)).toEqual(['x', 'y', 'extra']);
	});

	it('honors a Databricks `* EXCEPT (…)` exclude modifier', async () => {
		const sql = 'select * except (bb) from t';
		const model = await parser('databricks').parse(sql, { schema: { t: { aa: 'int', bb: 'int', cc: 'int' } } });
		expect(model.finalColumns.map(c => c.name)).toEqual(['aa', 'cc']);
	});

	it('leaves an unresolvable star unexpanded when no schema covers the table', async () => {
		// Base table `t`, no schema, no CTE to infer from — legacy cannot expand either,
		// so the star is dropped from finalColumns (bare `*` names nothing concrete).
		const model = await parser('databricks').parse('select * from t');
		expect(model.finalColumns).toEqual([]);
		expect(model.finalSelect!.columns).toEqual([]);
	});

	it('expands a CTE-sourced star COLD — no schema at all (the cold-star middle path)', async () => {
		// Legacy ran qualify with `infer_schema=True` unconditionally, so a star over
		// a CTE expanded with or without a catalog. The column-list extractors used to
		// gate this on a non-empty schema; ungated, an empty schema still expands the
		// structurally-inferable CTE columns — anchored star-exact.
		const sql = 'with a as (select x, y from t)\nselect * from a';
		const model = await parser('databricks').parse(sql);
		expect(model.finalColumns.map(c => c.name)).toEqual(['x', 'y']);
		const line1 = sql.split('\n')[1];
		expect(model.finalColumns.every(c => c.line === 1 && c.col === line1.indexOf('*'))).toBe(true);
		expect(model.finalSelect!.columns.map(c => c.name)).toEqual(['x', 'y']);
		expect(model.finalSelect!.columns.every(c => c.table === 'a')).toBe(true);
	});

	it('falls back cleanly when qualify() throws (expander is undefined)', async () => {
		// A malformed scope tree makes qualify() throw; buildStarExpander swallows it and
		// returns undefined so extraction proceeds unexpanded rather than crashing.
		const broken = { root: undefined } as unknown as ScopeTree;
		expect(buildStarExpander(broken, new Schema({}))).toBeUndefined();
	});
});

describe('SqllensDocumentParser — getDialectSymbols', () => {
	// The sets are LOWERCASE: every consumer (cap-keywords/functions/types, the reflow
	// printer) tests membership with `set.has(x.toLowerCase())`, matching the original
	// convention. keywordTokenTypes are TokenType names (select, alias…),
	// NOT keyword words; functions come from sqllens's own membership set, lowercased;
	// types mirror the DataType enum (the dialect-independent set).
	it('exposes keyword TokenTypes, functions, and types for databricks', async () => {
		const symbols = await parser('databricks').getDialectSymbols();
		expect(symbols).toBeDefined();
		// Single-word keyword token-type names only. Compound names (group_by,
		// order_by…) are excluded, mirroring the legacy `_get_dialect_symbols`
		// `isalpha()` filter (sql_parser.py) — keyword recasing never touches
		// multi-word tokens, so `GROUP BY` keeps its source casing (the format
		// oracles encode exactly that, see kitchen-sink.out.sql).
		expect(symbols!.keywordTokenTypes.has('group_by')).toBe(false);
		expect(symbols!.keywordTokenTypes.has('alias')).toBe(true); // the AS keyword
		expect(symbols!.keywordTokenTypes.has('select')).toBe(true);
		// A word mapped to VAR (removed keyword) must NOT be a keyword type.
		expect(symbols!.keywordTokenTypes.has('var')).toBe(false);
		// A known function and type.
		expect(symbols!.functions.has('coalesce')).toBe(true);
		expect(symbols!.types.has('int')).toBe(true);
		// Keyword WORDS (distinct from keywordTokenTypes) — the grammar literal set,
		// lowercased, used by hover/reference suppression.
		expect(symbols!.keywords.has('select')).toBe(true);
		expect(symbols!.keywords.has('from')).toBe(true);
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

describe('SqllensDocumentParser — completeAt / signatureAt', () => {
	it('offers dialect functions (ifnull) at a value slot in a jinja model', () => {
		// The exact shape of the reported gap: a CASE arm value position in a
		// Databricks jinja-SQL model. `ifnull` is a Databricks function, not a column.
		// Anchored at the START of the partial word (the value-slot offset) — the
		// completion provider anchors there so the walk sees an open expression slot,
		// not the token the partial word already parses as. See _completeSqlWords.
		const sql = 'select case when x is not null then ifn end as y\nfrom {{ ref(\'m\') }}';
		const offset = sql.indexOf('ifn');
		const items = parser('databricks').completeAt(sql, offset);
		const functions = items.filter(i => i.kind === 'function').map(i => i.label);
		expect(functions).toContain('ifnull');
	});

	// Fixed upstream in sqllens 1.2.0 (068d0c2): completeAt lexes the placeholder, not raw
	// text, so a leading {{ config() }} block no longer zeroes the candidate list.
	it('still offers functions when the model opens with a {{ config() }} block (regression)', () => {
		const sql = [
			'{{ config(materialized=\'table\') }}',
			'select',
			'  case when ve.x is not null then ifn else \'-1\' end as k',
			'from {{ ref(\'silver__vendor\') }} ve',
		].join('\n');
		const offset = sql.indexOf('then ifn') + 'then '.length;
		const functions = parser('databricks').completeAt(sql, offset).filter(i => i.kind === 'function').map(i => i.label);
		expect(functions).toContain('ifnull');
	});

	it('offers context keywords from the caret walk', () => {
		const sql = 'select 1 ';
		const items = parser('databricks').completeAt(sql, sql.length);
		const keywords = items.filter(i => i.kind === 'keyword').map(i => i.label.toLowerCase());
		// After `select 1 ` the grammar can continue with FROM (among others).
		expect(keywords).toContain('from');
	});

	it('answers a jinja ref() slot with dbt model names via the provider (REQ2 seam)', () => {
		// The whole seam end to end: sqllens finds the slot ({{ ref('cu → callee `ref`, arg 0),
		// asks our provider for that slot's candidates, and hands them back as kind "template".
		const models = new Map<string, unknown>([
			['model.p.customers', { name: 'customers', materialisation: 'table', packageName: 'p' }],
		]);
		const indexer = {
			index: { models, sources: new Map(), macros: new Map() },
		} as unknown as import('../../../indexing/manifest-indexer').ManifestIndexer;
		const describeCache = { columns: () => Promise.resolve(undefined) } as unknown as import('../../../dbt/describe-cache').DescribeCache;
		const provider = makeTemplateProvider(() => undefined, { indexer, describeCache });

		const sql = 'select 1 from {{ ref(\'cu';
		const items = parser('databricks').completeAt(sql, sql.length, provider);
		const templates = items.filter(i => i.kind === 'template').map(i => i.label);
		expect(templates).toContain('customers');
	});

	it('returns a signature for a SQL function call', () => {
		const sql = 'select date_add(order_date, 1) from t';
		const offset = sql.indexOf('order_date');
		const info = parser('databricks').signatureAt(sql, offset);
		expect(info).not.toBeNull();
		expect(info!.signatures[info!.activeSignature].label.toLowerCase()).toContain('date_add');
	});
});

describe('SqllensDocumentParser — decomposeQuery (JSON-string seam contract)', () => {
	// The debug adapter consumes decomposeQuery via `JSON.parse(raw)` (debug-adapter.ts),
	// so the wrapper MUST return a JSON string — not the typed object — and it must be
	// exactly `JSON.stringify(decompose(...))` for the resolved dialect. If the wrapper
	// ever returned the object, JSON.parse would throw and the debug adapter would break.
	const COMPILED = [
		'WITH base AS (',
		'  SELECT id, amount',
		'  FROM raw_sales rs',
		')',
		'SELECT id, amount FROM base',
	].join('\n');

	it('returns a JSON string that parses into the decompose contract shape', async () => {
		const raw = await parser('databricks').decomposeQuery(COMPILED);
		expect(typeof raw).toBe('string');

		const parsed = JSON.parse(raw);
		expect(parsed.success).toBe(true);
		expect(parsed).toHaveProperty('frames');
		expect(parsed).toHaveProperty('clauses');
		expect(parsed).toHaveProperty('refs');
		expect(parsed.frames.map((f: { name: string }) => f.name)).toEqual(
			expect.arrayContaining(['base', '_main_']),
		);
	});

	it('is byte-for-byte `JSON.stringify(decompose(sql, dialect))` for the adapter dialect', async () => {
		const raw = await parser('databricks').decomposeQuery(COMPILED);
		expect(raw).toBe(JSON.stringify(decompose(COMPILED, 'databricks')));
	});

	it('resolves the dialect from the adapter context (tsql routes to the tsql decompose)', async () => {
		const raw = await parser('tsql').decomposeQuery(COMPILED);
		expect(raw).toBe(JSON.stringify(decompose(COMPILED, 'tsql')));
	});
});

describe('SqllensDocumentParser — traceLineageV2 (LineageResult | { error } seam shape)', () => {
	// The canonical two-CTE hop chain lineage.test.ts exercises; the wrapper must produce
	// the SAME LineageResult get-column-lineage.ts consumes, distinguished from the error
	// arm by `'error' in result`.
	const CHAIN = 'WITH a AS (SELECT x+1 AS y FROM t), b AS (SELECT y*2 AS z FROM a) SELECT z FROM b';

	it('returns the LineageResult union arm (not an error) for a traceable column', async () => {
		const result = await parser('databricks').traceLineageV2(CHAIN, 'z', '{}');
		expect('error' in result).toBe(false);
		if ('error' in result) throw new Error('unreachable');
		expect(result.dependencies).toEqual([{ column: 'x', table: 't' }]);
		expect(result.via_ctes).toEqual(['b', 'a']);
	});

	it('parses schemaJson and delegates to traceColumnLineage with the resolved dialect', async () => {
		const raw = await parser('databricks').traceLineageV2(CHAIN, 'z', '{}');
		// The wrapper is a thin adapter over the free fn — the parsed empty schema and the
		// databricks dialect must reproduce the free-fn result exactly.
		expect(raw).toEqual(traceColumnLineage(CHAIN, 'z', 'databricks', {}));
	});

	it('maps a malformed schemaJson to the { error } arm rather than throwing', async () => {
		const result = await parser('databricks').traceLineageV2(CHAIN, 'z', 'not valid json');
		expect('error' in result).toBe(true);
		if (!('error' in result)) throw new Error('unreachable');
		expect(typeof result.error).toBe('string');
		expect(result.error.length).toBeGreaterThan(0);
	});
});

describe('SqllensDocumentParser — multi-statement documents (per-cell extraction)', () => {
	// The one real bug the shadow-triage census surfaced: a `;`-separated document
	// lowers to a flagged compound stub (empty body), and whole-doc extraction saw
	// NOTHING — 0 tokens, 0 ctes, 0 warnings. `_parseCells` splits on the query
	// editor's own splitter and runs the full pipeline per statement against a
	// masked view of the document, so every span is doc-native. The legacy parser
	// only extracted statement 1; statements 2..n are new (extracted per statement).

	const TWO = [
		'select a from t;', // 0
		'select b, c from u', // 1
	].join('\n');
	const TWO_LINES = TWO.split('\n');

	it('extracts symbols for EVERY statement at doc-native positions', async () => {
		const model = await parser().parse(TWO);
		const tok = (name: string) => {
			const sym = (model.symbols ?? []).find(s =>
				(s.kind === 'column' && s.name.split('.').pop() === name) || (isRelationSym(s) && s.name === name),
			);
			if (!sym) return undefined;
			const range = sym.kind === 'column' ? nameRangeOf(sym) : rangeOfSpan(sym.span);
			return { line: range.start.line, col: range.start.character };
		};

		// statement 1
		expect(tok('a')?.line).toBe(0);
		expect(tok('t')?.line).toBe(0);
		expect(tok('t')?.col).toBe(TWO_LINES[0].lastIndexOf('t'));
		// statement 2 — the whole-doc compound stub used to drop all of this
		expect(tok('b')?.line).toBe(1);
		expect(tok('c')?.line).toBe(1);
		expect(tok('u')?.line).toBe(1);
		expect(tok('u')?.col).toBe(TWO_LINES[1].indexOf('u'));
		expect(model.parseWarnings ?? []).toEqual([]);
	});

	it('finalSelect/finalColumns describe the LAST statement — the script result set', async () => {
		const model = await parser().parse(TWO);
		expect(model.finalColumns.map(c => c.name)).toEqual(['b', 'c']);
		expect(model.finalSelect).toBeDefined();
		expect(model.finalSelect!.line).toBe(1);
	});

	it('extracts jinja refs in later statements with doc-native spans', async () => {
		const sql = 'select a from t;\nselect x from {{ ref(\'dim_x\') }}';
		const model = await parser().parse(sql);
		expect(model.refs.map(r => r.model)).toEqual(['dim_x']);
		expect(model.refs[0].line).toBe(1);
		expect(model.refs[0].jinjaCol).toBe(sql.split('\n')[1].indexOf('{{'));
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 'dim_x' && s.span.line - 1 === 1)).toBe(true);
	});

	it('a syntax error in one statement does not suppress the others', async () => {
		// `)))` is this file's canonical broken input (see the parse-failure block);
		// bare `select a from ;` is NOT an error — `from` parses as `a`'s alias.
		const model = await parser().parse('select a from t )));\nselect b from u');
		const errs = (model.parseWarnings ?? []).filter(w => w.type === 'syntax_error');
		expect(errs.length).toBeGreaterThan(0);
		expect(errs.every(w => w.line === 0)).toBe(true); // all in statement 1
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 'u' && s.span.line - 1 === 1)).toBe(true);
	});

	it('extracts CTEs in later statements with doc-native lines', async () => {
		const model = await parser().parse('select 1;\nwith x as (select 2 as n) select n from x');
		expect(model.ctes.map(c => c.name)).toEqual(['x']);
		expect(model.ctes[0].line).toBe(1);
		expect(model.finalColumns.map(c => c.name)).toEqual(['n']);
	});

	it('handles a config-topped multi-statement scratch (jinja before statement 1)', async () => {
		const sql = '{{ config(materialized=\'table\') }}\nselect a from t;\nselect b from u';
		const model = await parser().parse(sql);
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 't' && s.span.line - 1 === 1)).toBe(true);
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 'u' && s.span.line - 1 === 2)).toBe(true);
	});

	it('composes the reflow astIndex across statements — AST precision beyond statement 1', async () => {
		const model = await parser().parse(TWO);
		const inStmt1 = TWO.indexOf('a from');
		const inStmt2 = TWO.indexOf('b, c');
		expect(model.astIndex!.enclosingClasses(inStmt1)).toContain('Select');
		expect(model.astIndex!.enclosingClasses(inStmt2)).toContain('Select');
	});

	it('leaves a single statement with trailing `;` on the whole-doc path', async () => {
		// One element -> never flagged compound -> no split, byte-identical to today.
		const model = await parser().parse('select a from t;\n');
		expect((model.symbols ?? []).some(s => isRelationSym(s) && s.name === 't' && s.span.line - 1 === 0)).toBe(true);
		expect(model.finalColumns.map(c => c.name)).toEqual(['a']);
	});
});
