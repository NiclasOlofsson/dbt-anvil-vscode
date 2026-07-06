import { describe, expect, it } from 'vitest';
import { decompose, type DecomposeClause } from '../../../ftl/sqllens/decompose';

/** Pull a frame's clause list, asserting the frame exists. */
function clausesOf(res: ReturnType<typeof decompose>, frame: string): DecomposeClause[] {
	expect(res.success).toBe(true);
	expect(res.clauses[frame]).toBeDefined();
	return res.clauses[frame];
}

function stage(clauses: DecomposeClause[], name: string): DecomposeClause | undefined {
	return clauses.find(c => c.stage === name);
}

describe('decompose — single SELECT, no CTEs', () => {
	// Intentionally odd spacing on `weird_col` — must survive verbatim into the stage SQL.
	const sql = [
		'SELECT id,   weird_col , total',
		'FROM sales s',
		'WHERE s.total > 100',
	].join('\n');

	const res = decompose(sql, 'databricks');

	it('produces a single _main_ frame of type select', () => {
		expect(res.success).toBe(true);
		expect(res.frames.map(f => f.name)).toEqual(['_main_']);
		expect(res.frames[0].type).toBe('select');
		expect(res.frames[0].line).toBe(0);
	});

	it('from stage is a runnable SELECT * over the FROM region', () => {
		const from = stage(clausesOf(res, '_main_'), 'from')!;
		expect(from.sql).toBe('SELECT * FROM sales s');
		expect(from.line).toBe(1); // FROM is on line 2 (0-based 1)
		expect(from.order).toBe(0);
	});

	it('where stage is runnable and contains the FROM text', () => {
		const where = stage(clausesOf(res, '_main_'), 'where')!;
		expect(where.sql).toBe('SELECT * FROM sales s\nWHERE s.total > 100');
		expect(where.line).toBe(2);
	});

	it('select stage is the full query with original spacing preserved', () => {
		const select = stage(clausesOf(res, '_main_'), 'select')!;
		expect(select.sql).toBe(sql);
		expect(select.sql).toContain('id,   weird_col , total'); // verbatim odd spacing
		expect(select.line).toBe(0);
	});

	it('refs list the top-level FROM target', () => {
		expect(res.refs['_main_']).toEqual(['sales']);
	});

	it('every non-empty stage SQL is runnable-shaped (starts with SELECT/WITH)', () => {
		for (const c of clausesOf(res, '_main_')) {
			if (c.sql === '') continue;
			expect(c.sql).toMatch(/^\s*(SELECT|WITH)\b/i);
		}
	});
});

describe('decompose — 2-CTE chain with WHERE / GROUP BY / HAVING / ORDER BY', () => {
	const lines = [
		'WITH base AS (',                       // 0
		'  SELECT region, amount',              // 1
		'  FROM raw_sales rs',                  // 2
		'  WHERE rs.amount > 0',                // 3
		'),',                                   // 4
		'agg AS (',                             // 5
		'  SELECT region, sum(amount) AS total',// 6
		'  FROM base',                          // 7
		'  GROUP BY region',                    // 8
		'  HAVING sum(amount) > 10',            // 9
		')',                                    // 10
		'SELECT region, total',                 // 11
		'FROM agg',                             // 12
		'ORDER BY total DESC',                  // 13
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'databricks');

	it('enumerates base, agg and _main_ frames with correct line ranges', () => {
		expect(res.success).toBe(true);
		expect(res.frames.map(f => f.name)).toEqual(['base', 'agg', '_main_']);
		const base = res.frames.find(f => f.name === 'base')!;
		expect(base.type).toBe('cte');
		expect(base.line).toBe(0);   // `base` name on line 0
		expect(base.endLine).toBe(4); // closing `)` on line 4
		const agg = res.frames.find(f => f.name === 'agg')!;
		expect(agg.line).toBe(5);
		expect(agg.endLine).toBe(10);
		const main = res.frames.find(f => f.name === '_main_')!;
		expect(main.type).toBe('select');
		expect(main.line).toBe(11);
		expect(main.endLine).toBe(13);
	});

	it('base frame: from + where stages, no WITH prefix (first CTE)', () => {
		const cs = clausesOf(res, 'base');
		expect(cs.map(c => c.stage)).toEqual(['from', 'where', 'select']);
		expect(stage(cs, 'from')!.sql).toBe('SELECT * FROM raw_sales rs');
		expect(stage(cs, 'from')!.line).toBe(2);
		expect(stage(cs, 'where')!.sql).toBe('SELECT * FROM raw_sales rs\n  WHERE rs.amount > 0');
		expect(stage(cs, 'where')!.line).toBe(3);
	});

	it('agg frame: group + having stages carry the WITH prefix for base', () => {
		const cs = clausesOf(res, 'agg');
		expect(cs.map(c => c.stage)).toEqual(['from', 'group', 'having', 'select']);

		const group = stage(cs, 'group')!;
		expect(group.line).toBe(8);
		expect(group.sql.startsWith('WITH base AS (')).toBe(true);
		// Real projections (not SELECT *), through GROUP BY, join/where text between kept.
		expect(group.sql).toContain('SELECT region, sum(amount) AS total');
		expect(group.sql.trimEnd().endsWith('GROUP BY region')).toBe(true);

		const having = stage(cs, 'having')!;
		expect(having.line).toBe(9);
		expect(having.sql.trimEnd().endsWith('HAVING sum(amount) > 10')).toBe(true);
	});

	it('_main_ frame: order stage present, select stage is the whole WITH query', () => {
		const cs = clausesOf(res, '_main_');
		expect(cs.map(c => c.stage)).toEqual(['from', 'select', 'order']);
		const from = stage(cs, 'from')!;
		expect(from.sql.startsWith('WITH base AS (')).toBe(true);
		expect(from.sql.trimEnd().endsWith('SELECT * FROM agg')).toBe(true);

		const select = stage(cs, 'select')!;
		expect(select.sql).toBe(sql); // full query, already opens with WITH → no double prefix
		expect(select.line).toBe(11);

		const order = stage(cs, 'order')!;
		expect(order.sql).toBe(sql);
		expect(order.line).toBe(13);
	});

	it('refs chain base → raw_sales, agg → base, _main_ → agg', () => {
		expect(res.refs['base']).toEqual(['raw_sales']);
		expect(res.refs['agg']).toEqual(['base']);
		expect(res.refs['_main_']).toEqual(['agg']);
	});
});

describe('decompose — UNION inside a CTE (legs tagged)', () => {
	const lines = [
		'WITH combined AS (',            // 0
		'  SELECT id, 1 AS src',         // 1
		'  FROM table_a',                // 2
		'  UNION ALL',                   // 3
		'  SELECT id, 2 AS src',         // 4
		'  FROM table_b',                // 5
		')',                             // 6
		'SELECT * FROM combined',        // 7
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'databricks');

	it('tags each leg with union_leg / union_total', () => {
		const cs = clausesOf(res, 'combined');
		const legs = cs.map(c => c.union_leg);
		expect(new Set(legs)).toEqual(new Set([1, 2]));
		for (const c of cs) expect(c.union_total).toBe(2);

		const leg1 = cs.filter(c => c.union_leg === 1);
		const leg2 = cs.filter(c => c.union_leg === 2);
		expect(leg1.map(c => c.stage)).toEqual(['from', 'select']);
		expect(leg2.map(c => c.stage)).toEqual(['from', 'select']);
	});

	it('leg from stages point at each leg FROM line and are runnable', () => {
		const cs = clausesOf(res, 'combined');
		const fromStages = cs.filter(c => c.stage === 'from');
		expect(fromStages[0].sql).toBe('SELECT * FROM table_a');
		expect(fromStages[0].line).toBe(2);
		expect(fromStages[1].sql).toBe('SELECT * FROM table_b');
		expect(fromStages[1].line).toBe(5);
	});

	it('order index is contiguous across the combined leg clauses', () => {
		const cs = clausesOf(res, 'combined');
		expect(cs.map(c => c.order)).toEqual([0, 1, 2, 3]);
	});

	it('refs collect both leg tables', () => {
		expect(res.refs['combined']).toEqual(['table_a', 'table_b']);
	});
});

describe('decompose — single JOIN (from excludes joins, one join stage)', () => {
	const lines = [
		'SELECT o.id, c.name',                     // 0
		'FROM orders o',                           // 1
		'INNER JOIN customers c ON o.cust = c.id', // 2
		'WHERE o.total > 50',                      // 3
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'databricks');

	it('emits exactly one join stage, cumulative from FROM through the join', () => {
		const joins = clausesOf(res, '_main_').filter(c => c.stage === 'join');
		expect(joins.length).toBe(1);
		expect(joins[0].sql).toBe('SELECT * FROM orders o\nINNER JOIN customers c ON o.cust = c.id');
		expect(joins[0].line).toBe(2);
	});

	it('from stage EXCLUDES the join text now that Join nodes exist', () => {
		const from = stage(clausesOf(res, '_main_'), 'from')!;
		expect(from.sql).toBe('SELECT * FROM orders o');
		expect(from.sql).not.toContain('JOIN');
		expect(from.line).toBe(1);
	});

	it('where stage still contains the JOIN text via the contiguous slice', () => {
		const where = stage(clausesOf(res, '_main_'), 'where')!;
		expect(where.sql).toContain('INNER JOIN customers c ON o.cust = c.id');
		expect(where.sql).toBe(
			'SELECT * FROM orders o\nINNER JOIN customers c ON o.cust = c.id\nWHERE o.total > 50',
		);
		expect(where.sql).toMatch(/^SELECT/);
	});

	it('stage order interleaves from < join < where', () => {
		const cs = clausesOf(res, '_main_');
		expect(cs.map(c => c.stage)).toEqual(['from', 'join', 'where', 'select']);
		expect(cs.map(c => c.order)).toEqual([0, 1, 2, 3]);
	});

	it('refs list base then joined table in declaration order', () => {
		expect(res.refs['_main_']).toEqual(['orders', 'customers']);
	});
});

describe('decompose — databricks 2-join chain (INNER + LEFT)', () => {
	const lines = [
		'SELECT o.id, c.name, p.sku',              // 0
		'FROM orders o',                           // 1
		'INNER JOIN customers c ON o.cust = c.id', // 2
		'LEFT JOIN products p ON o.prod = p.id',   // 3
		'WHERE o.total > 50',                      // 4
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'databricks');

	const j1 = 'SELECT * FROM orders o\nINNER JOIN customers c ON o.cust = c.id';
	const j2 = j1 + '\nLEFT JOIN products p ON o.prod = p.id';

	it('from stage is the base source only — no join text', () => {
		const from = stage(clausesOf(res, '_main_'), 'from')!;
		expect(from.sql).toBe('SELECT * FROM orders o');
		expect(from.line).toBe(1);
	});

	it('emits two cumulative join stages with exact original formatting', () => {
		const joins = clausesOf(res, '_main_').filter(c => c.stage === 'join');
		expect(joins.length).toBe(2);
		expect(joins[0].sql).toBe(j1);
		expect(joins[0].line).toBe(2);
		expect(joins[1].sql).toBe(j2);
		expect(joins[1].line).toBe(3);
	});

	it('where stage accumulates both joins', () => {
		const where = stage(clausesOf(res, '_main_'), 'where')!;
		expect(where.sql).toBe(j2 + '\nWHERE o.total > 50');
		expect(where.line).toBe(4);
	});

	it('order indices interleave from < join1 < join2 < where', () => {
		const cs = clausesOf(res, '_main_');
		expect(cs.map(c => c.stage)).toEqual(['from', 'join', 'join', 'where', 'select']);
		expect(cs.map(c => c.order)).toEqual([0, 1, 2, 3, 4]);
	});

	it('refs list base then both joined tables in declaration order', () => {
		expect(res.refs['_main_']).toEqual(['orders', 'customers', 'products']);
	});
});

describe('decompose — USING join', () => {
	const lines = [
		'SELECT o.id, c.name',               // 0
		'FROM orders o',                     // 1
		'INNER JOIN customers c USING (id)', // 2
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'databricks');

	it('join stage carries the USING clause verbatim', () => {
		const joins = clausesOf(res, '_main_').filter(c => c.stage === 'join');
		expect(joins.length).toBe(1);
		expect(joins[0].sql).toBe('SELECT * FROM orders o\nINNER JOIN customers c USING (id)');
		expect(joins[0].line).toBe(2);
	});

	it('from stage excludes the USING join', () => {
		expect(stage(clausesOf(res, '_main_'), 'from')!.sql).toBe('SELECT * FROM orders o');
	});
});

describe('decompose — CROSS JOIN (no ON predicate)', () => {
	const lines = [
		'SELECT o.id, r.zone',  // 0
		'FROM orders o',        // 1
		'CROSS JOIN regions r', // 2
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'databricks');

	it('emits a cumulative CROSS JOIN stage', () => {
		const joins = clausesOf(res, '_main_').filter(c => c.stage === 'join');
		expect(joins.length).toBe(1);
		expect(joins[0].sql).toBe('SELECT * FROM orders o\nCROSS JOIN regions r');
		expect(joins[0].line).toBe(2);
	});

	it('from stage is the base source only', () => {
		expect(stage(clausesOf(res, '_main_'), 'from')!.sql).toBe('SELECT * FROM orders o');
	});
});

describe('decompose — trino 3-join chain (cumulative cst spans)', () => {
	const lines = [
		'SELECT o.id',                             // 0
		'FROM orders o',                           // 1
		'INNER JOIN customers c ON o.cust = c.id', // 2
		'LEFT JOIN products p ON o.prod = p.id',   // 3
		'JOIN regions r ON r.id = o.reg',          // 4
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'trino');

	const j1 = 'SELECT * FROM orders o\nINNER JOIN customers c ON o.cust = c.id';
	const j2 = j1 + '\nLEFT JOIN products p ON o.prod = p.id';
	const j3 = j2 + '\nJOIN regions r ON r.id = o.reg';

	it('per-join lines are the actual JOIN keyword lines, not the chain start (line 1)', () => {
		const joins = clausesOf(res, '_main_').filter(c => c.stage === 'join');
		expect(joins.length).toBe(3);
		// trino join.cst.start is the chain start (line 1 = the FROM source) for ALL three joins;
		// the derived lines must instead be each join's own keyword line.
		expect(joins.map(c => c.line)).toEqual([2, 3, 4]);
	});

	it('cumulative stage SQL accumulates the chain in source order', () => {
		const joins = clausesOf(res, '_main_').filter(c => c.stage === 'join');
		expect(joins[0].sql).toBe(j1);
		expect(joins[1].sql).toBe(j2);
		expect(joins[2].sql).toBe(j3);
	});

	it('from stage excludes every join', () => {
		const from = stage(clausesOf(res, '_main_'), 'from')!;
		expect(from.sql).toBe('SELECT * FROM orders o');
		expect(from.line).toBe(1);
	});
});

describe('decompose — comma-separated FROM sources are NOT joins', () => {
	const lines = [
		'SELECT a.id, b.id',  // 0
		'FROM t1 a, t2 b',    // 1
		'WHERE a.id = b.id',  // 2
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'databricks');

	it('emits no join stages', () => {
		expect(clausesOf(res, '_main_').some(c => c.stage === 'join')).toBe(false);
	});

	it('from stage carries both comma sources', () => {
		expect(stage(clausesOf(res, '_main_'), 'from')!.sql).toBe('SELECT * FROM t1 a, t2 b');
	});

	it('refs list both comma sources', () => {
		expect(res.refs['_main_']).toEqual(['t1', 't2']);
	});
});

describe('decompose — tsql dialect', () => {
	const lines = [
		'SELECT id, name',      // 0
		'FROM dbo.people p',    // 1
		'WHERE p.age > 21',     // 2
	];
	const sql = lines.join('\n');
	const res = decompose(sql, 'tsql');

	it('decomposes a T-SQL single select', () => {
		expect(res.success).toBe(true);
		const cs = clausesOf(res, '_main_');
		expect(stage(cs, 'from')!.sql).toBe('SELECT * FROM dbo.people p');
		expect(stage(cs, 'where')!.sql).toBe('SELECT * FROM dbo.people p\nWHERE p.age > 21');
		expect(stage(cs, 'where')!.line).toBe(2);
	});

	it('refs use the last name part of a schema-qualified table', () => {
		expect(res.refs['_main_']).toEqual(['people']);
	});
});

// ── Subquery promotion — ported from the legacy oracle
//    (src/test/debug-symbols-integration.test.ts, 'decompose_query subquery promotion'). ──

describe('decompose — subquery promotion to synthetic CTE frames', () => {
	it('promotes a FROM subquery to a synthetic CTE frame', () => {
		const sql = [
			'SELECT t.id, t.name',
			'FROM (SELECT id, name FROM raw_customers WHERE active = 1) t',
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		// Synthetic frame promoted from the FROM subquery (alias 't' used as CTE name)
		const syntheticFrame = result.frames.find(f => f.name === 't');
		expect(syntheticFrame, 'synthetic frame for FROM subquery').toBeDefined();
		expect(syntheticFrame!.type).toBe('cte');

		// _main_ refs should now point to the synthetic CTE 't'
		expect(result.refs['_main_']).toContain('t');
	});

	it('promotes a JOIN subquery to a synthetic CTE frame', () => {
		const sql = [
			'WITH base AS (SELECT id FROM raw_orders)',
			'SELECT b.id, w.total',
			'FROM base b',
			'INNER JOIN (SELECT order_id, sum(amount) AS total FROM raw_items GROUP BY ALL) w',
			'  ON b.id = w.order_id',
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		// 'w' is the JOIN subquery alias → becomes a synthetic CTE named 'w'
		const syntheticFrame = result.frames.find(f => f.name === 'w');
		expect(syntheticFrame, 'synthetic frame for JOIN subquery').toBeDefined();
		expect(syntheticFrame!.type).toBe('cte');

		// _main_ (which sees base and w) should ref both
		expect(result.refs['_main_']).toContain('w');

		// base CTE should still exist
		expect(result.frames.find(f => f.name === 'base')).toBeDefined();
	});

	it('handles a subquery with no alias using a generated name', () => {
		const sql = 'SELECT * FROM (SELECT id FROM raw_customers) AS anon_sub';

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		// 'anon_sub' alias used as CTE name
		expect(result.frames.find(f => f.name === 'anon_sub')).toBeDefined();
	});

	it('generates __subq_N__ for a truly alias-less subquery (legacy naming scheme)', () => {
		const result = decompose('SELECT * FROM (SELECT id FROM raw_customers)', 'duckdb');
		expect(result.success).toBe(true);

		const synthetic = result.frames.find(f => f.name === '__subq_1__');
		expect(synthetic, '__subq_1__ frame').toBeDefined();
		expect(synthetic!.type).toBe('cte');
		expect(result.refs['_main_']).toContain('__subq_1__');
	});

	it('synthetic frame clauses are runnable slices of the subquery body', () => {
		const sql = [
			'SELECT t.id',
			'FROM (SELECT id FROM raw_customers WHERE active = 1) t',
		].join('\n');

		const result = decompose(sql, 'duckdb');
		const cs = clausesOf(result, 't');
		expect(cs.map(c => c.stage)).toEqual(['from', 'where', 'select']);
		expect(stage(cs, 'select')!.sql).toBe('SELECT id FROM raw_customers WHERE active = 1');
		expect(result.refs['t']).toEqual(['raw_customers']);
	});
});

// ── UNION leg promotion — ported from the legacy oracle
//    (src/test/debug-symbols-integration.test.ts, 'decompose_query UNION leg promotion'). ──

describe('decompose — top-level UNION leg promotion', () => {
	it('promotes each leg of a top-level UNION ALL into its own __union_N__ frame', () => {
		const sql = [
			'SELECT id, name FROM raw_a WHERE active = 1', // 0
			'UNION ALL',                                   // 1
			'SELECT id, name FROM raw_b WHERE active = 1', // 2
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		const u1 = result.frames.find(f => f.name === '__union_1__');
		const u2 = result.frames.find(f => f.name === '__union_2__');
		expect(u1, '__union_1__ frame').toBeDefined();
		expect(u2, '__union_2__ frame').toBeDefined();

		// Branch 1 occupies line 0; branch 2 starts at line 2. Both frame
		// ranges are tight — line 1 (UNION ALL keyword) falls in the gap.
		expect(u1!.line).toBe(0);
		expect(u1!.endLine).toBe(0);
		expect(u2!.line).toBe(2);
		expect(u2!.endLine).toBe(2);
	});

	it('leaves a UNION-keyword-only line outside any frame range', () => {
		const sql = [
			'SELECT 1 AS x',   // 0
			'UNION ALL',       // 1 ← should NOT match any frame
			'SELECT 2 AS x',   // 2
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		// Simulate the frame-matching logic: for each source-line, does any
		// synthetic union frame contain it?
		const unionFrames = result.frames.filter(f => f.name.startsWith('__union_'));
		expect(unionFrames.length).toBeGreaterThanOrEqual(2);

		// Line 1 is the UNION keyword. Assert no union frame covers it
		// (excluding _main_ which always covers the whole range).
		const coveringUnion = unionFrames.find(f => 1 >= f.line && 1 <= f.endLine);
		expect(coveringUnion, 'UNION-keyword line should fall between __union_1__ and __union_2__').toBeUndefined();
	});

	it('promotes UNION legs inside a CTE body', () => {
		const sql = [
			'WITH foo AS (',                  // 0
			'  SELECT id FROM raw_a',         // 1
			'  UNION ALL',                    // 2
			'  SELECT id FROM raw_b',         // 3
			')',                              // 4
			'SELECT * FROM foo',              // 5
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		// Original CTE still present.
		expect(result.frames.find(f => f.name === 'foo')).toBeDefined();

		// Two synthetic leg frames.
		const legs = result.frames.filter(f => f.name.startsWith('__union_'));
		expect(legs.length).toBe(2);
	});

	it('concatenates clauses across UNION branches in _main_', () => {
		const sql = [
			'SELECT id FROM raw_a WHERE x = 1',  // 0
			'UNION ALL',                         // 1
			'SELECT id FROM raw_b WHERE y = 2',  // 2
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		const mainClauses = result.clauses['_main_'];
		expect(mainClauses, '_main_ clauses').toBeDefined();

		// Both branches' FROM/WHERE/SELECT should appear, in source order.
		const stages = mainClauses.map(c => c.stage);
		expect(stages.filter(s => s === 'from').length).toBe(2);
		expect(stages.filter(s => s === 'where').length).toBe(2);
		expect(stages.filter(s => s === 'select').length).toBe(2);

		// Lines must be monotonically non-decreasing.
		for (let i = 1; i < mainClauses.length; i++) {
			expect(mainClauses[i].line).toBeGreaterThanOrEqual(mainClauses[i - 1].line);
		}
	});

	it('still succeeds (no regression) on a plain SELECT with no UNION', () => {
		const result = decompose('SELECT id FROM t WHERE id = 1', 'duckdb');
		expect(result.success).toBe(true);
		expect(result.frames.find(f => f.name === '_main_')).toBeDefined();
		// No synthetic union frames.
		expect(result.frames.filter(f => f.name.startsWith('__union_'))).toHaveLength(0);
	});

	it('records SELECT clause line at the SELECT keyword, not the first projection', () => {
		// SELECT keyword on its own line, projections indented on the next line.
		// A breakpoint on the SELECT keyword line must resolve to the SELECT
		// clause (previously it resolved to WHERE because find_clause_line
		// picked up the first identifier's line instead of the keyword's).
		const sql = [
			'SELECT',           // 0 ← SELECT keyword
			'  id,',            // 1 ← first projected identifier
			'  name',           // 2
			'FROM t',           // 3
			'WHERE id = 1',     // 4
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);
		const selectClause = result.clauses['_main_'].find(c => c.stage === 'select');
		expect(selectClause, 'SELECT clause').toBeDefined();
		expect(selectClause!.line).toBe(0);
	});

	it('records branch-2 SELECT clause at the SELECT keyword line (UNION with multi-line legs)', () => {
		// Mirrors the gold__item.sql shape: branch 2 is all literals with the
		// SELECT keyword on its own line. Previously this clause was recorded
		// one line too late, so a breakpoint on the SELECT keyword matched
		// branch 1's WHERE instead of branch 2's SELECT.
		const sql = [
			'SELECT id FROM t',         // 0
			'UNION ALL',                // 1
			'SELECT',                   // 2 ← branch 2 SELECT keyword
			'  \'-1\' AS id,',          // 3 ← first identifier (alias)
			'  \'nd\' AS name',         // 4
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		const mainClauses = result.clauses['_main_'];
		const selectLines = mainClauses.filter(c => c.stage === 'select').map(c => c.line);
		// Two SELECTs, branch 1 at line 0, branch 2 at line 2 (keyword line).
		expect(selectLines).toEqual([0, 2]);
	});

	it('last leg frame extends to the end of the statement; leg clauses are per-leg slices', () => {
		const sql = [
			'SELECT id FROM raw_a',  // 0
			'UNION ALL',             // 1
			'SELECT id FROM raw_b',  // 2
			'ORDER BY id',           // 3
		].join('\n');

		const result = decompose(sql, 'duckdb');
		expect(result.success).toBe(true);

		const u2 = result.frames.find(f => f.name === '__union_2__')!;
		expect(u2.line).toBe(2);
		expect(u2.endLine).toBe(3); // last leg runs to end of statement (legacy rule)

		// Each __union_N__ frame carries its own untagged from/select stages.
		const cs1 = clausesOf(result, '__union_1__');
		expect(cs1.map(c => c.stage)).toEqual(['from', 'select']);
		expect(stage(cs1, 'from')!.sql).toBe('SELECT * FROM raw_a');
		expect(cs1.every(c => c.union_leg === undefined)).toBe(true);
		expect(result.refs['__union_1__']).toEqual(['raw_a']);
		expect(result.refs['__union_2__']).toEqual(['raw_b']);
	});
});

describe('decompose — error handling', () => {
	it('returns success:false for empty input', () => {
		const res = decompose('', 'databricks');
		expect(res.success).toBe(false);
		expect(res.error).toMatch(/required/i);
	});
});
