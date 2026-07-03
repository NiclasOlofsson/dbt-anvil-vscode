import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { parse, resolveScopes, type Dialect } from './api';
import { createSqllensAstIndex } from './ast-index';
import type { SqllensParse } from './extract/spans';
import { SqllensDocumentParser } from './document-parser';
import { reflowDocument } from '../../ninja/reflow/engine';
import { DEFAULT_CONFIG, type NinjaConfig } from '../../ninja/config';
import { PRESETS, type FormatPreset } from '../../ninja/presets';
import { mockDocument } from '../../test/ninja/helpers';

/** Run the tiers of sqllens the DocumentModel is built from, as the parser does. */
function sqllensParse(sql: string, dialect: Dialect = 'databricks'): SqllensParse {
	const pr = parse(sql, dialect);
	return {
		ast: pr.ast,
		dialect,
		errors: pr.errors,
		diagnostics: pr.diagnostics,
		scopes: resolveScopes(pr.ast, dialect),
		tokens: pr.tokens,
	};
}

function index(sql: string, dialect: Dialect = 'databricks') {
	return createSqllensAstIndex(sqllensParse(sql, dialect), sql);
}

describe('createSqllensAstIndex — Join / ON', () => {
	// Three joins: single-predicate, multi-predicate (AND), single-predicate.
	const SQL =
		'select 1 from a join b on a.id = b.id ' +
		'join c on b.id = c.id and b.x = c.x ' +
		'join d on c.id = d.id';

	it('reports Join as an enclosing class at each ON offset', () => {
		const ix = index(SQL);
		for (const on of ['on a.id', 'on b.id', 'on c.id']) {
			const off = SQL.indexOf(on);
			expect(ix.enclosingClasses(off)).toContain('Join');
		}
	});

	it('picks the correct innermost Join in a 3-join chain', () => {
		const ix = index(SQL);
		// findEnclosing at each ON must return a span that contains only THAT
		// join's predicate — the mid join's AND must not leak into its neighbours.
		const onB = SQL.indexOf('on a.id'); // first join's ON
		const onC = SQL.indexOf('on b.id'); // middle join's ON (multi-predicate)
		const onD = SQL.indexOf('on c.id'); // last join's ON

		const jb = ix.findEnclosing(onB, 'Join')!;
		const jc = ix.findEnclosing(onC, 'Join')!;
		const jd = ix.findEnclosing(onD, 'Join')!;
		expect(jb).toBeDefined();
		expect(jc).toBeDefined();
		expect(jd).toBeDefined();

		// containsAny finds the AND only inside the middle join.
		expect(ix.containsAny(jb.start, jb.end, ['And', 'Or'])).toBe(false);
		expect(ix.containsAny(jc.start, jc.end, ['And', 'Or'])).toBe(true);
		expect(ix.containsAny(jd.start, jd.end, ['And', 'Or'])).toBe(false);
	});

	it('does not see AND inside a single-comparison ON', () => {
		const ix = index('select 1 from a join b on a.id = b.id');
		const j = ix.findEnclosing(SQL.indexOf('on a.id'), 'Join');
		expect(j).toBeDefined();
		expect(ix.containsAny(j!.start, j!.end, ['And', 'Or'])).toBe(false);
	});
});

describe('createSqllensAstIndex — Join / ON (trino cumulative spans)', () => {
	// Trino's join.cst is cumulative (each JoinRelation includes its left input),
	// so all joins in a chain share a start offset. Containment still resolves the
	// innermost join for the LAST join's ON, and enclosingClasses reports 'Join'.
	const SQL = 'select a from t join u on t.a = u.a join v on u.b = v.b join w on v.c = w.c';

	it('reports Join enclosure and a coherent innermost at the tail ON', () => {
		const ix = index(SQL, 'trino');
		const onLast = SQL.indexOf('on v.c');
		expect(ix.enclosingClasses(onLast)).toContain('Join');
		// The tightest Join span containing the tail ON is the last join's span.
		const j = ix.findEnclosing(onLast, 'Join')!;
		expect(j).toBeDefined();
		expect(SQL.slice(j.start, j.end + 1)).toContain('on v.c = w.c');
	});
});

describe('createSqllensAstIndex — Case', () => {
	it('findEnclosing Case returns the tighter nested CASE for an inner offset', () => {
		const SQL = 'select case when a then case when b then 1 else 2 end else 3 end as c from t';
		const ix = index(SQL);
		const innerOff = SQL.indexOf('then 1'); // inside the nested CASE
		const outerOnlyOff = SQL.indexOf('when a'); // outer CASE only

		const inner = ix.findEnclosing(innerOff, 'Case')!;
		const outer = ix.findEnclosing(outerOnlyOff, 'Case')!;
		expect(inner).toBeDefined();
		expect(outer).toBeDefined();
		// The inner match is strictly tighter than the outer match.
		expect(inner.end - inner.start).toBeLessThan(outer.end - outer.start);
		expect(SQL.slice(inner.start, inner.end + 1)).toBe('case when b then 1 else 2 end');
	});
});

describe('createSqllensAstIndex — isCteOrSubqueryBodyOpen', () => {
	it('is true at a CTE body opening paren', () => {
		const SQL = 'with x as (select 1) select 2 from x';
		const ix = index(SQL);
		expect(ix.isCteOrSubqueryBodyOpen(SQL.indexOf('('))).toBe(true);
	});

	it('is true at a FROM subquery opening paren', () => {
		const SQL = 'select a from (select 1 as a) s';
		const ix = index(SQL);
		expect(ix.isCteOrSubqueryBodyOpen(SQL.indexOf('('))).toBe(true);
	});

	it('is false at a function-call paren', () => {
		const SQL = 'select coalesce(a, b) from t';
		const ix = index(SQL);
		expect(ix.isCteOrSubqueryBodyOpen(SQL.indexOf('('))).toBe(false);
	});
});

describe('createSqllensAstIndex — With / CTE containment', () => {
	const SQL = 'with x as (select a, b from t) select a from x';

	it('encloses offsets inside a CTE body with With + Subquery + Select', () => {
		const ix = index(SQL);
		const insideBody = SQL.indexOf('a, b'); // inside the CTE body select list
		const cls = ix.enclosingClasses(insideBody);
		expect(cls).toContain('With');
		expect(cls).toContain('Subquery');
		expect(cls).toContain('Select');
	});

	it('does not enclose the outer SELECT in With', () => {
		const ix = index(SQL);
		const outer = SQL.indexOf('select a from x') + 'select '.length; // the outer `a`
		expect(ix.enclosingClasses(outer)).not.toContain('With');
	});
});

describe('createSqllensAstIndex — degenerate parse', () => {
	it('reports empty for an offset with no positioned enclosure', () => {
		const ix = index('select 1');
		// Far past the end of the source: nothing encloses it.
		expect(ix.enclosingClasses(9999)).toEqual([]);
		expect(ix.innermostClass(9999)).toBeUndefined();
		expect(ix.isCteOrSubqueryBodyOpen(9999)).toBe(false);
	});

	it('leaves the model index undefined on a pass2 (rendered-space) parse', async () => {
		// A statement-level macro breaks every length-preserving blank, forcing the
		// nunjucks-render pass (pass2). Its offsets are rendered-space, so the parser
		// must NOT attach an index — the reflow path falls back to an empty index.
		const sql = 'select a from t\n{{ some_statement_macro() }}\nselect b from u';
		const model = await new SqllensDocumentParser({ adapterType: 'databricks' }).parse(sql);
		expect(model.isPass2).toBe(true);
		expect(model.astIndex).toBeUndefined();
	});

	it('attaches an index on a clean (pass1) parse', async () => {
		const model = await new SqllensDocumentParser({ adapterType: 'databricks' }).parse('select a from t');
		expect(model.isPass2).toBeFalsy();
		expect(model.astIndex).toBeDefined();
		expect(model.astIndex!.empty).toBe(false);
	});
});

// ── Integration: format real fixtures through the sqllens path ──────────────
// The committed *.out.sql fixtures were produced by the sqlglot (Pyodide) parser
// + reflow printer. Formatting the SAME input through SqllensDocumentParser (whose
// model carries the IR-built astIndex) must reach the same output — proving the
// index drives the printer's AST-aware decisions equivalently.

const FIXTURES_DIR = path.join(__dirname, '..', '..', 'test', 'ninja', 'fixtures', 'format');

function buildConfig(preset: FormatPreset = 'sqlfmt'): NinjaConfig {
	const p = PRESETS[preset];
	return {
		...DEFAULT_CONFIG,
		format: { preset },
		capitalisation: { ...DEFAULT_CONFIG.capitalisation, ...p.capitalisation },
		indentation: { ...DEFAULT_CONFIG.indentation, ...p.indentation },
		layout: {
			...DEFAULT_CONFIG.layout,
			...p.layout,
			alwaysWrap: { ...DEFAULT_CONFIG.layout.alwaysWrap, ...p.layout?.alwaysWrap },
		},
		convention: { ...DEFAULT_CONFIG.convention, ...p.convention },
		structure: { ...DEFAULT_CONFIG.structure, ...p.structure },
		maxLineLength: p.maxLineLength ?? DEFAULT_CONFIG.maxLineLength,
		maxBlankLines: p.maxBlankLines ?? DEFAULT_CONFIG.maxBlankLines,
	};
}

function fixturePreset(name: string): FormatPreset {
	const presetPath = path.join(FIXTURES_DIR, `${name}.preset`);
	if (!fs.existsSync(presetPath)) return 'sqlfmt';
	return fs.readFileSync(presetPath, 'utf8').trim() as FormatPreset;
}

describe('SqllensDocumentParser reflow parity with committed fixtures', () => {
	const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });
	// Representative of the AST-index-driven decisions: CTE bodies + separators,
	// select-list commas, JOIN ON multi-predicate + paren groups, GROUP/HAVING.
	const FIXTURES = ['all-col-0', 'short-select-inline', 'join-on-mixed-paren'];

	for (const name of FIXTURES) {
		it(`formats ${name} to match the committed output`, async () => {
			const input = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.in.sql`), 'utf8');
			const expected = fs.readFileSync(path.join(FIXTURES_DIR, `${name}.out.sql`), 'utf8');
			const config = buildConfig(fixturePreset(name));

			const model = await parser.parse(input);
			const reflow = reflowDocument(mockDocument(input), model, config);
			const actual = reflow.edit ? reflow.edit.newText : input;
			expect(actual).toBe(expected);
		});
	}
});
