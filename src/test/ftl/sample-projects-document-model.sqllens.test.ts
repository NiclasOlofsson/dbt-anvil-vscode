/**
 * Live-engine end-to-end coverage: run every real sample-project model through
 * the LIVE parser — `SqllensDocumentParser` (stage 4 default) — the sqllens twin
 * of `sample-projects-document-model.test.ts` (which still runs on legacy Pyodide
 * and validates the engine we turned OFF).
 *
 * This is the platform-stability check: it brute-forces all 68 real jaffle_shop +
 * nba-monte-carlo models through the parser that actually ships, so a real-world
 * parse crash or structurally-broken DocumentModel fails here rather than surfacing
 * as a runtime bug (the lineage 0-deps class). sqllens is synchronous — no Pyodide
 * boot — so this runs fast and can assert harder than the legacy smoke test.
 *
 * Assertion strategy: FAIL on a throw or a malformed model (missing array fields).
 * COLLECT per-model parse-error / extraction stats and report them in the summary
 * so the real-world landscape is visible; the summary asserts aggregate health.
 */
import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import { SqllensDocumentParser } from '../../ftl/sqllens/document-parser';
import type { ColumnRefToken } from '../../services/parse-service';

const SAMPLES_ROOT = path.join(__dirname, '..', '..', '..', 'samples');

function collectSqlFiles(dir: string): string[] {
	const results: string[] = [];
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			results.push(...collectSqlFiles(full));
		} else if (entry.isFile() && entry.name.endsWith('.sql')) {
			results.push(full);
		}
	}
	return results;
}

const MODEL_DIRS = [
	path.join(SAMPLES_ROOT, 'jaffle_shop', 'models'),
	path.join(SAMPLES_ROOT, 'nba-monte-carlo', 'models'),
];

const SQL_FILES = MODEL_DIRS.flatMap(d => (fs.existsSync(d) ? collectSqlFiles(d) : []));

// Fully macro-generated models — `with cte as ({{ macro() }}) {{ macro_end() }}` with no
// literal SQL body. Neither engine can parse them without rendering the (undefined) macros;
// both fall through to nunjucks render and extract nothing. Enumerated so the token-stream
// assertion still catches a NEW model regressing to empty. Shared limitation, targeted by the
// jinja workstream (variant expansion / catalog rendering), not a sqllens defect.
const KNOWN_MACRO_ONLY = new Set([
	'nba-monte-carlo/models/nba/simulator/playoffs/playoff_sim_r1.sql',
	'nba-monte-carlo/models/nba/simulator/playoffs/playoff_sim_r2.sql',
	'nba-monte-carlo/models/nba/simulator/playoffs/playoff_sim_r3.sql',
	'nba-monte-carlo/models/nba/simulator/playoffs/playoff_sim_r4.sql',
]);

interface FileResult {
	label: string;
	warnings: number;
	extraction: { ctes: number; refs: number; sources: number; finalColumns: number; tokens: number };
}
const RESULTS: FileResult[] = [];

// nba-monte-carlo is duckdb; jaffle_shop is duckdb in this samples set. One parser,
// duckdb dialect, matching the legacy test's DUCKDB_CONTEXT.
const parser = new SqllensDocumentParser({ adapterType: 'duckdb' });

describe('sample project DocumentModel (sqllens — live engine)', () => {
	it('found SQL files to test', () => {
		expect(SQL_FILES.length).toBeGreaterThan(0);
	});

	for (const filePath of SQL_FILES) {
		const label = filePath.replace(SAMPLES_ROOT + path.sep, '').replaceAll('\\', '/');

		it(label, async () => {
			const raw = fs.readFileSync(filePath, 'utf8');
			const model = await parser.parse(raw);

			// Structural well-formedness — a malformed model is a live-path bug.
			expect(Array.isArray(model.ctes)).toBe(true);
			expect(Array.isArray(model.refs)).toBe(true);
			expect(Array.isArray(model.sources)).toBe(true);
			expect(Array.isArray(model.finalColumns)).toBe(true);
			expect(Array.isArray(model.tokens)).toBe(true);
			expect(typeof model.timing.parseMs).toBe('number');
			expect(typeof model.timing.totalMs).toBe('number');

			RESULTS.push({
				label,
				warnings: (model.sqlglotWarnings ?? []).length,
				extraction: {
					ctes: model.ctes.length,
					refs: model.refs.length,
					sources: model.sources.length,
					finalColumns: model.finalColumns.length,
					tokens: model.tokens.length,
				},
			});
		});
	}

	it('summary — aggregate live-engine health', () => {
		const total = RESULTS.length;
		const withWarn = RESULTS.filter(r => r.warnings > 0).length;

		console.log(`\nsqllens DocumentModel summary: ${total} real models parsed, ${withWarn} with warnings`);
		expect(total).toBeGreaterThan(0);

		// Every model with a literal SQL body must produce SOME token stream — a totally
		// empty token list means the SQL body never reached the parser (blank cascade or
		// dialect routing broken). The KNOWN_MACRO_ONLY models are the exception: they are
		// fully macro-generated (`with cte as ({{ macro() }}) {{ macro_end() }}`) with NO
		// literal SQL, so BOTH engines fall through to nunjucks render and extract nothing.
		// That is the jinja-rendering limitation the jinja workstream targets, not a
		// regression — but it stays enumerated here so any NEW model going empty fails loudly.
		const unexpectedEmpty = RESULTS
			.filter(r => r.extraction.tokens === 0 && !KNOWN_MACRO_ONLY.has(r.label))
			.map(r => r.label);
		expect(unexpectedEmpty).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// qualify() dialect regression (sqllens twin) — GROUP BY ALL (DuckDB) + cross-CTE
// SELECT * expansion.
//
// Legacy sqlglot qualify() expands `SELECT * FROM cte_interim_calcs` in cte_final
// into resolved column_ref tokens (name=home_team, resolvedTableRef=cte_interim_calcs).
// The native path restores that format in extractTokens Pass 3: synthetic zero-width
// column_refs re-emitted from the star expander, one per expanded column, resolved to
// the source's table_ref. Downstream this is what keeps the unused-columns ninja rule
// from false-flagging every star-consumed CTE column.
// ---------------------------------------------------------------------------
describe('qualify() dialect regression (sqllens)', () => {
	it('reg_season_predictions — SELECT * in cte_final expands to column_refs for cte_interim_calcs columns', async () => {
		const filePath = path.join(
			SAMPLES_ROOT, 'nba-monte-carlo', 'models', 'nba', 'analysis', 'reg_season_predictions.sql',
		);
		const raw = fs.readFileSync(filePath, 'utf8');

		const schema: Record<string, Record<string, string>> = {
			reg_season_simulator: { game_id: 'varchar', home_team: 'varchar', visiting_team: 'varchar' },
			nba_teams: { team: 'varchar' },
			nba_results_by_team: { team: 'varchar', score: 'varchar' },
		};

		const model = await parser.parse(raw, { schema });

		const columnRefs = (model.tokens ?? []).filter((t): t is ColumnRefToken => t.type === 'column_ref');
		const interimColRefs = columnRefs.filter(
			t => t.resolvedTableRef?.name.toLowerCase() === 'cte_interim_calcs',
		);
		const homeTeamRefs = interimColRefs.filter(t => t.name.toLowerCase() === 'home_team');
		expect(homeTeamRefs.length).toBeGreaterThan(0);
	});
});
