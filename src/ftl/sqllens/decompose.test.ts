import { describe, expect, it } from 'vitest';
import { decompose, type DecomposeClause } from './decompose';

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

describe('decompose — error handling', () => {
	it('returns success:false for empty input', () => {
		const res = decompose('', 'databricks');
		expect(res.success).toBe(false);
		expect(res.error).toMatch(/required/i);
	});
});
