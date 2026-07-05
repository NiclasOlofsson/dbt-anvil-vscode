import { describe, expect, it } from 'vitest';
import { SqllensDocumentParser } from './document-parser';
import { decompose } from './decompose';
import { traceColumnLineage } from './lineage';
import { buildStarExpander } from './extract/star-expand';
import { Schema, type ScopeTree } from './api';
import type { ColumnRefToken, TableRefToken, TokenInfo } from '../../services/parse-service';

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

		// 1-part bare column: no qualifier IN SOURCE, but qualify binds it to the single FROM
		// source `foo as a` — matching legacy sqlglot's qualify, which rewrote bare `bare` →
		// `a.bare`. So `.table` is the resolved alias `a` (consumed from Qualification.bindingOf),
		// with NO tableCol span since the qualifier is synthesized, not a real source token.
		const bare = col('bare');
		expect(bare).toMatchObject({ name: 'bare', line: 1, col: 2, endCol: 6 });
		expect(bare.table).toBe('a');
		expect(bare.tableCol).toBeUndefined();

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
	// col=11/endCol=17 there. The NAME is dialect-normalized (databricks is
	// case-insensitive, so a backtick-quoted name is lowercased too) — that's
	// `normName`'s domain, not the span logic, and the span is unchanged (the
	// normalized name has the same length as the raw stripped text here).
	it('places a backtick-quoted column + unquoted qualifier (databricks)', async () => {
		const sql = 'select a.`My Col` from t as a';
		const model = await parser('databricks').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'my col',
		)!;
		const q = sql.indexOf('`My Col`');
		expect(col).toMatchObject({
			name: 'my col', // databricks lowercases even a quoted identifier
			line: 0,
			endCol: q + '`My Col`'.length,          // after the closing backtick
			col: q + '`My Col`'.length - 'my col'.length, // legacy quirk: not the opening backtick
			table: 'a',
			tableCol: sql.indexOf('a.'),
			tableEndCol: sql.indexOf('a.') + 1,
		});
	});

	it('places a bracket-quoted column + unquoted qualifier (tsql)', async () => {
		const sql = 'select a.[My Col] from t as a';
		const model = await parser('tsql').parse(sql);
		const col = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name === 'my col',
		)!;
		const q = sql.indexOf('[My Col]');
		expect(col).toMatchObject({
			name: 'my col', // tsql is case-insensitive: a bracket-quoted name is lowercased
			endCol: q + '[My Col]'.length,
			col: q + '[My Col]'.length - 'my col'.length,
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
			table: 'my table', // databricks lowercases the quoted qualifier too
			tableEndCol: tq + '`My Table`'.length,
			tableCol: tq + '`My Table`'.length - 'my table'.length,
		});
	});
});

describe('SqllensDocumentParser — dialect-aware identifier case normalization', () => {
	// `normName` reproduces sqlglot's per-dialect `normalize_identifier` (which the
	// legacy path applies via qualify() -> normalize_identifiers before serializing
	// the AST). Three strategies span the eight sqllens dialects:
	//   - CASE_INSENSITIVE (databricks/tsql/bigquery/redshift/duckdb/trino): everything
	//     lowercased, quoted included.
	//   - UPPERCASE (snowflake): unquoted uppercased, quoted preserved.
	//   - LOWERCASE (postgres): unquoted lowercased, quoted preserved.
	// Each case verified against FtlDocumentParser through the shadow-diff harness.

	const colRefNames = (model: { tokens: readonly TokenInfo[] }): string[] =>
		model.tokens
			.filter((t): t is ColumnRefToken => t.type === 'column_ref')
			.map(t => t.name);

	it('databricks: unquoted lowercased, backtick-quoted lowercased', async () => {
		const model = await parser('databricks').parse('select Upper_Col, `Mixed`\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'mixed']);
		expect(colRefNames(model)).toEqual(expect.arrayContaining(['upper_col', 'mixed']));
	});

	it('tsql: unquoted lowercased, bracket-quoted lowercased', async () => {
		const model = await parser('tsql').parse('select Upper_Col, [Mixed]\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'mixed']);
	});

	it('duckdb: unquoted lowercased, double-quoted lowercased (case-insensitive)', async () => {
		const model = await parser('duckdb').parse('select Upper_Col, "Mixed"\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'mixed']);
	});

	it('snowflake: unquoted UPPERCASED, double-quoted preserved', async () => {
		const model = await parser('snowflake').parse('select Upper_Col, "Mixed"\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['UPPER_COL', 'Mixed']);
		expect(colRefNames(model)).toEqual(expect.arrayContaining(['UPPER_COL', 'Mixed']));
	});

	it('postgres: unquoted lowercased, double-quoted preserved', async () => {
		const model = await parser('postgres').parse('select Upper_Col, "Mixed"\nfrom foo');
		expect(model.finalColumns.map(c => c.name)).toEqual(['upper_col', 'Mixed']);
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
		const def = model.tokens.find(t => t.type === 'column_def' && t.name === 'x')!;
		expect(def.line).toBe(0);
		expect(def.col).toBe('select a + b as '.length); // `x`, not the comment token
		expect(def.endCol).toBe('select a + b as x'.length);

		const col = model.finalSelect!.columns.find(c => c.name === 'x')!;
		expect(col.aliasCol).toBe('select a + b as '.length);
		expect(col.aliasEndCol).toBe('select a + b as x'.length);
	});

	it('anchors the alias of a parenthesized expression projection', async () => {
		const sql = 'select (a+b) as x from t';
		const model = await parser().parse(sql);
		const def = model.tokens.find(t => t.type === 'column_def' && t.name === 'x')!;
		expect(def.col).toBe('select (a+b) as '.length);
		expect(def.endCol).toBe('select (a+b) as x'.length);
	});
});

describe('SqllensDocumentParser — parse-failure paths', () => {
	it('reports syntax_error warnings with 0-based positions for broken SQL', async () => {
		const model = await parser().parse('select a from t )))');
		const errs = (model.sqlglotWarnings ?? []).filter(w => w.type === 'syntax_error');
		expect(errs.length).toBeGreaterThan(0);
		expect(errs[0].line).toBe(0);
		expect(typeof errs[0].col).toBe('number');
		expect(errs[0].endCol).toBeGreaterThan(errs[0].col!);
	});

	it('yields an error-tolerant partial model for an unshaped statement-level macro', async () => {
		// The macro sits between two full statements and no shapeOf is bound, so the
		// identifier fill leaves invalid SQL. There is no render pass anymore: the
		// partial parse IS the result — raw coordinates (isPass2 never set), syntax
		// errors surfaced as warnings, and the tag-AST still delivers the macro call.
		const sql = 'select a from t\n{{ some_statement_macro() }}\nselect b from u';
		const model = await parser().parse(sql);
		expect(model.isPass2).toBeFalsy();
		expect((model.sqlglotWarnings ?? []).some(w => w.type === 'syntax_error')).toBe(true);
		expect((model.macroCalls ?? []).map(m => m.name)).toContain('some_statement_macro');
		// Statement 1 parsed — its table ref survives in the token stream.
		expect(model.tokens.some(t => t.type === 'table_ref' && t.name === 't')).toBe(true);
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
		// snowflake's NORMALIZATION_STRATEGY is UPPERCASE — unquoted identifiers are
		// uppercased (matching legacy sqlglot's normalize_identifier), unlike the
		// lowercasing case-insensitive dialects above.
		const model = await parser('snowflake').parse('select a, b from t');
		expect(model.finalColumns.map(c => c.name)).toEqual(['A', 'B']);
		expect(model.tokens.some(t => t.type === 'table_ref' && t.name === 'T')).toBe(true);
		expect(model.sqlglotWarnings).toEqual([]);
	});
});

describe('SqllensDocumentParser — schema-fed SELECT * expansion', () => {
	// A 2-level `{ table: { column: type } }` map — the exact shape ParseService builds
	// from the manifest indexer + describe cache, assignable directly to sqllens Schema.
	const T_SCHEMA = { t: { aa: 'int', bb: 'string' } };

	it('expands a top-level `select * from t` into the schema columns, anchored at the star', async () => {
		const sql = 'select * from t';
		const model = await parser('databricks').parse(sql, { schema: T_SCHEMA });

		expect(model.finalColumns.map(c => c.name)).toEqual(['aa', 'bb']);
		// Every expanded column anchors at the `*` token: col = starEndCol - name.length.
		const starEnd = sql.indexOf('*') + 1;
		expect(model.finalColumns.find(c => c.name === 'aa')!.col).toBe(starEnd - 'aa'.length);
		expect(model.finalColumns.find(c => c.name === 'bb')!.col).toBe(starEnd - 'bb'.length);

		// finalSelect columns carry the qualified source (`t.aa`) as table + expression.
		const fs = model.finalSelect!.columns;
		expect(fs.map(c => c.name)).toEqual(['aa', 'bb']);
		expect(fs.every(c => c.table === 't')).toBe(true);
		expect(fs.find(c => c.name === 'aa')!.expression).toBe('aa');
	});

	it('expands a CTE-chain wildcard by inference once a schema is supplied for the base table', async () => {
		// `b` is a pure `select *` CTE — legacy keeps its `*` (wildcardCtes side-channel),
		// but the TOP-level `select * from b` still expands via the inferred CTE columns.
		// A schema only for the base `t` is enough — the CTE columns are inferred from it.
		const sql = 'with a as (select x, y from t),\nb as (select * from a)\nselect * from b';
		const model = await parser('databricks').parse(sql, { schema: { t: { x: 'int', y: 'int' } } });

		expect(model.finalColumns.map(c => c.name)).toEqual(['x', 'y']);
		expect(model.ctes.find(c => c.name === 'a')!.columns.map(c => c.name)).toEqual(['x', 'y']);
		// The sole-bare-star CTE keeps its wildcard entry, matching the legacy path.
		expect(model.ctes.find(c => c.name === 'b')!.columns.map(c => c.name)).toEqual(['*']);
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

	it('falls back cleanly when qualify() throws (expander is undefined)', async () => {
		// A malformed scope tree makes qualify() throw; buildStarExpander swallows it and
		// returns undefined so extraction proceeds unexpanded rather than crashing.
		const broken = { root: undefined } as unknown as ScopeTree;
		expect(buildStarExpander(broken, new Schema({}))).toBeUndefined();
	});
});

describe('SqllensDocumentParser — getDialectSymbols', () => {
	// The sets are LOWERCASE: every consumer (cap-keywords/functions/types, the reflow
	// printer) tests membership with `set.has(x.toLowerCase())`, matching the sqlglot
	// path's contract. keywordTokenTypes are sqlglot TokenType NAMES (select, alias…),
	// NOT keyword words; functions come from sqllens's own membership set, lowercased;
	// types mirror sqlglot's DataType.Type enum (the legacy dialect-independent set).
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
