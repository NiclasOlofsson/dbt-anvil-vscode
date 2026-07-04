/**
 * Shadow-mode diff harness for the sqlglot -> sqllens parser migration.
 *
 *   npx tsx scripts/shadow-diff.ts [--dir <path>] [--dialect <d>] [--max N]
 *
 * Boots ONE in-process Pyodide/sqlglot parser (the legacy `FtlDocumentParser`,
 * exactly as `src/test/ftl/sample-projects-document-model.test.ts` does headless)
 * and the native `SqllensDocumentParser`, runs both over a SQL corpus, and
 * field-by-field diffs the two `DocumentModel`s. Known-acceptable differences are
 * suppressed (see `canonicalize`); everything else is a reported parity diff.
 *
 * NOT part of `npm test`. It is a report, never a gate: exit code is always 0.
 *
 * Corpus (default): the repo's own SQL — format fixtures under
 * `src/test/ninja/fixtures/format` (`.in.sql`, databricks) plus the sample dbt
 * projects' model SQL under `samples/.../models` (duckdb). `--dir` overrides
 * with a single root; `--dialect` overrides the per-file dialect everywhere.
 *
 * Report: a summary table on stdout + full per-file detail to
 * `temp_auto/shadow-diff-report.md`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { initPyodide } from '../src/ftl/pyodide-loader';
import { PyodideSqlParser } from '../src/ftl/pyodide-sql-parser';
import { FtlDocumentParser, type AdapterContext } from '../src/ftl/ftl-document-parser';
import { SqllensDocumentParser } from '../src/ftl/sqllens/document-parser';
import type { DocumentModel } from '../src/services/parse-service';

const ROOT = path.resolve(__dirname, '..');
const PYODIDE_DIR = path.join(ROOT, 'node_modules', 'pyodide');
const VENDOR_DIR = path.join(ROOT, 'resources', 'ftl', 'vendor');
const SCRIPTS_DIR = path.join(ROOT, 'resources', 'ftl');
const REPORT_PATH = path.join(ROOT, 'temp_auto', 'shadow-diff-report.md');

/** A corpus root: where to collect from, which file suffix, and the default dialect. */
interface CorpusRoot {
	dir: string;
	/** Only files ending in this suffix are collected (format fixtures ship .out.sql/.preset siblings). */
	suffix: string;
	/** dbt adapter type -> selects sqlglot dialect (legacy) and sqllens dialect. */
	adapter: string;
}

/**
 * Per-root dialect table. Format fixtures are dialect-neutral dbt SQL — read as
 * databricks (the widest sqllens grammar); the nba/jaffle sample projects are
 * duckdb, which exercises sqllens's duckdb dialect specifically.
 */
const DEFAULT_ROOTS: CorpusRoot[] = [
	{ dir: path.join(ROOT, 'src', 'test', 'ninja', 'fixtures', 'format'), suffix: '.in.sql', adapter: 'databricks' },
	{ dir: path.join(ROOT, 'samples', 'nba-monte-carlo', 'models'), suffix: '.sql', adapter: 'duckdb' },
	{ dir: path.join(ROOT, 'samples', 'jaffle_shop', 'models'), suffix: '.sql', adapter: 'duckdb' },
];

interface Args {
	dir?: string;
	dialect?: string;
	max: number;
}

function parseArgs(argv: string[]): Args {
	const args: Args = { max: 100 };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === '--dir') args.dir = argv[++i];
		else if (a === '--dialect') args.dialect = argv[++i];
		else if (a === '--max') args.max = Number(argv[++i]);
		else if (a.startsWith('--dir=')) args.dir = a.slice('--dir='.length);
		else if (a.startsWith('--dialect=')) args.dialect = a.slice('--dialect='.length);
		else if (a.startsWith('--max=')) args.max = Number(a.slice('--max='.length));
	}
	if (!Number.isFinite(args.max) || args.max <= 0) args.max = 100;
	return args;
}

function collectSqlFiles(dir: string, suffix: string): string[] {
	const out: string[] = [];
	if (!fs.existsSync(dir)) return out;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) out.push(...collectSqlFiles(full, suffix));
		else if (entry.isFile() && entry.name.endsWith(suffix)) out.push(full);
	}
	return out;
}

interface CorpusFile { path: string; adapter: string; label: string; root: string }

function discoverCorpus(args: Args): CorpusFile[] {
	const files: CorpusFile[] = [];
	if (args.dir) {
		const dir = path.resolve(args.dir);
		const adapter = args.dialect ?? 'databricks';
		const root = path.relative(ROOT, dir).replace(/\\/g, '/') || dir;
		for (const f of collectSqlFiles(dir, '.sql')) {
			files.push({ path: f, adapter, label: path.relative(dir, f).replace(/\\/g, '/'), root });
		}
		return files;
	}
	for (const rootDef of DEFAULT_ROOTS) {
		const adapter = args.dialect ?? rootDef.adapter;
		const root = path.relative(ROOT, rootDef.dir).replace(/\\/g, '/');
		for (const f of collectSqlFiles(rootDef.dir, rootDef.suffix)) {
			files.push({ path: f, adapter, label: path.relative(ROOT, f).replace(/\\/g, '/'), root });
		}
	}
	return files;
}

// ---------------------------------------------------------------------------
// Canonicalization — strip the known-acceptable differences before diffing.
// (See the migration plan + EXTRACTOR-MAP.md for why each is expected.)
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** Sort helper: stable positional ordering so index drift never masquerades as a diff. */
function by(...keys: string[]): (a: Json, b: Json) => number {
	return (a, b) => {
		for (const k of keys) {
			const av = a[k] as string | number | undefined;
			const bv = b[k] as string | number | undefined;
			if (av === bv) continue;
			if (av === undefined) return -1;
			if (bv === undefined) return 1;
			return av < bv ? -1 : 1;
		}
		return 0;
	};
}

/**
 * A jinja-tag placeholder identifier, in either engine's spelling: legacy blankJinja
 * mints `__jN__` unique IDs; sqllens's templated pre-lexer fills the tag's exact width
 * with `jjj…`. Both stand for "an unexpanded jinja tag in a value slot" — the NAME is
 * meaningless filler in both, so the two spellings are the same semantic and are
 * canonicalized to one marker (name + the tag-width-dependent endCol) before diffing.
 * A REAL identifier never matches (`__j0__` is reserved-shaped; nobody names a column
 * 4+ bare j's).
 */
const PLACEHOLDER_RE = /^(?:__j\d+__|j{4,})$/;

/** Reduce a TokenInfo to its comparable shape: drop scopeId, fold resolvedTableRef to
 *  name+line, and normalize jinja-placeholder names (legacy `__jN__` vs native `jjj…`). */
function canonToken(t: Json): Json {
	const { scopeId: _scopeId, resolvedTableRef, ...rest } = t as Record<string, unknown>;
	const rtr = resolvedTableRef as Json | undefined;
	const out: Json = {
		...rest,
		resolvedTableRef: rtr ? { name: rtr.name, line: rtr.line } : undefined,
	};
	if (typeof out.name === 'string' && PLACEHOLDER_RE.test(out.name)) {
		out.name = '⟨jinja⟩';
		out.endCol = out.col; // width is placeholder-scheme-dependent, not semantic
	}
	return out;
}

/**
 * Project a DocumentModel onto its comparable surface:
 *  - drop `ast` (absent by design), `aliases` (dead), `pivotVirtualColumns`
 *    (absent), `timing` (always differs);
 *  - filter `scope_warning` entries (no sqllens analog);
 *  - `ninjaSqlTokens` -> (type, start, end) tuples only;
 *  - token `scopeId` dropped, `resolvedTableRef` compared by name+line;
 *  - `isPass2` dropped when the file is a pure syntax error.
 */
function canonicalize(m: DocumentModel, pureSyntaxError: boolean): Json {
	const model = m as unknown as Json;
	const warnings = (m.sqlglotWarnings ?? []).filter(w => w.type !== 'scope_warning');
	const ninja = (m.ninjaSqlTokens ?? []).map(t => {
		const j = t as unknown as Json;
		return { type: j.type, start: j.start, end: j.end };
	});
	return {
		ctes: (m.ctes ?? []).map(c => c as unknown as Json).sort(by('line', 'col', 'name')),
		refs: (m.refs ?? []).map(r => r as unknown as Json).sort(by('line', 'col', 'model')),
		sources: (m.sources ?? []).map(s => s as unknown as Json).sort(by('line', 'col')),
		macroCalls: (m.macroCalls ?? []).map(mc => mc as unknown as Json).sort(by('line', 'col', 'name')),
		finalColumns: (m.finalColumns ?? []).map(c => c as unknown as Json).sort(by('line', 'col', 'name')),
		finalSelect: m.finalSelect ? canonFinalSelect(m.finalSelect as unknown as Json) : undefined,
		tokens: (m.tokens ?? []).map(t => canonToken(t as unknown as Json)).sort(by('line', 'col', 'type', 'name')),
		warnings: warnings.map(w => w as unknown as Json).sort(by('type', 'line', 'col')),
		jinjaTokens: (m.jinjaTokens ?? []).map(j => j as unknown as Json).sort(by('start', 'end', 'type')),
		ninjaSqlTokens: ninja.sort(by('start', 'end', 'type')),
		status: model.status,
		isPass2: pureSyntaxError ? undefined : m.isPass2,
	};
}

function canonFinalSelect(fs: Json): Json {
	const cols = ((fs.columns as Json[] | undefined) ?? []).map(c => {
		// A computed column whose source is a jinja tag carries the tag PLACEHOLDER as its
		// expression text (`__jN__` legacy / `jjj…` native) — same semantic, normalize.
		if (typeof c.expression === 'string' && PLACEHOLDER_RE.test(c.expression)) {
			return { ...c, expression: '⟨jinja⟩' };
		}
		return c;
	});
	return { ...fs, columns: cols.slice().sort(by('line', 'col', 'name')) };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

interface Diff { path: string; legacy: unknown; sqllens: unknown; kind?: string }

function isObject(v: unknown): v is Json {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Structural diff of two arbitrary JSON values (objects/primitives; arrays handled by caller). */
function diffValue(a: unknown, b: unknown, p: string, out: Diff[]): void {
	if (a === b) return;
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) out.push({ path: `${p}.length`, legacy: a.length, sqllens: b.length });
		const n = Math.min(a.length, b.length);
		for (let i = 0; i < n; i++) diffValue(a[i], b[i], `${p}[${i}]`, out);
		return;
	}
	if (isObject(a) && isObject(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		for (const k of keys) diffValue(a[k], b[k], p ? `${p}.${k}` : k, out);
		return;
	}
	out.push({ path: p, legacy: a, sqllens: b });
}

/**
 * Diff two arrays of records grouped by a positional key. Same-key elements are
 * paired and deep-diffed (surfacing field-level diffs); unpaired elements are
 * reported as missing/extra. Robust to ordering and to one side having more.
 */
function diffArrayByKey(a: Json[], b: Json[], p: string, keyFn: (x: Json) => string, out: Diff[]): void {
	const groups = new Map<string, { a: Json[]; b: Json[] }>();
	const get = (k: string): { a: Json[]; b: Json[] } => {
		let g = groups.get(k);
		if (!g) { g = { a: [], b: [] }; groups.set(k, g); }
		return g;
	};
	for (const x of a) get(keyFn(x)).a.push(x);
	for (const x of b) get(keyFn(x)).b.push(x);
	for (const [k, g] of groups) {
		const n = Math.min(g.a.length, g.b.length);
		for (let i = 0; i < n; i++) diffValue(g.a[i], g.b[i], `${p}[${k}]`, out);
		for (let i = n; i < g.a.length; i++) out.push({ path: `${p}[]`, kind: 'missing-in-sqllens', legacy: g.a[i], sqllens: undefined });
		for (let i = n; i < g.b.length; i++) out.push({ path: `${p}[]`, kind: 'extra-in-sqllens', legacy: undefined, sqllens: g.b[i] });
	}
}

function diffModels(L: Json, S: Json, out: Diff[]): void {
	const arr = (v: unknown): Json[] => (Array.isArray(v) ? (v as Json[]) : []);
	diffArrayByKey(arr(L.ctes), arr(S.ctes), 'ctes', c => `${c.line}:${c.col}:${c.name}`, out);
	diffArrayByKey(arr(L.tokens), arr(S.tokens), 'tokens', t => `${t.line}:${t.col}:${t.type}`, out);
	diffArrayByKey(arr(L.refs), arr(S.refs), 'refs', r => `${r.line}:${r.col}:${r.model}`, out);
	diffArrayByKey(arr(L.sources), arr(S.sources), 'sources', s => `${s.line}:${s.col}`, out);
	diffArrayByKey(arr(L.macroCalls), arr(S.macroCalls), 'macroCalls', m => `${m.line}:${m.col}:${m.name}`, out);
	diffArrayByKey(arr(L.finalColumns), arr(S.finalColumns), 'finalColumns', c => `${c.line}:${c.col}:${c.name}`, out);
	diffArrayByKey(arr(L.warnings), arr(S.warnings), 'sqlglotWarnings', w => `${w.type}:${w.line}:${w.col}`, out);
	diffArrayByKey(arr(L.jinjaTokens), arr(S.jinjaTokens), 'jinjaTokens', j => `${j.start}:${j.end}:${j.type}`, out);
	diffArrayByKey(arr(L.ninjaSqlTokens), arr(S.ninjaSqlTokens), 'ninjaSqlTokens', j => `${j.start}:${j.end}:${j.type}`, out);

	// finalSelect: scalar fields directly, columns by key.
	const lf = L.finalSelect as Json | undefined, sf = S.finalSelect as Json | undefined;
	if (!lf || !sf) {
		if (lf !== sf) out.push({ path: 'finalSelect', legacy: lf ? 'present' : 'absent', sqllens: sf ? 'present' : 'absent' });
	} else {
		for (const k of ['line', 'col', 'endLine', 'endCol'] as const) {
			if (lf[k] !== sf[k]) out.push({ path: `finalSelect.${k}`, legacy: lf[k], sqllens: sf[k] });
		}
		diffArrayByKey(arr(lf.columns), arr(sf.columns), 'finalSelect.columns', c => `${c.line}:${c.col}:${c.name}`, out);
	}

	if (L.status !== S.status) out.push({ path: 'status', legacy: L.status, sqllens: S.status });
	if (L.isPass2 !== S.isPass2) out.push({ path: 'isPass2', legacy: L.isPass2, sqllens: S.isPass2 });
}

/** Normalize an array index / group key in a diff path to `[]` for histogramming. */
function histogramPath(d: Diff): string {
	const base = d.path.replace(/\[[^\]]*\]/g, '[]');
	return d.kind ? `${base} (${d.kind})` : base;
}

function trunc(v: unknown, n = 140): string {
	if (v === undefined) return 'undefined';
	let s: string;
	try { s = JSON.stringify(v); } catch { s = String(v); }
	if (s === undefined) s = String(v);
	return s.length > n ? s.slice(0, n) + '…' : s;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface FileReport { label: string; adapter: string; diffs: Diff[]; error?: string }

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const all = discoverCorpus(args);
	const corpus = all.slice(0, args.max);

	// Report the corpus breakdown per root before the (slow) Pyodide boot.
	const perRoot = new Map<string, number>();
	for (const f of all) perRoot.set(f.root, (perRoot.get(f.root) ?? 0) + 1);
	process.stdout.write(`Discovered ${all.length} SQL files (running ${corpus.length}, --max ${args.max}):\n`);
	for (const [root, n] of perRoot) process.stdout.write(`  ${n.toString().padStart(4)}  ${root}\n`);
	process.stdout.write('\nBooting Pyodide/sqlglot (legacy parser)…\n');

	const runtime = await initPyodide(PYODIDE_DIR, VENDOR_DIR, SCRIPTS_DIR);
	const sqlParser = PyodideSqlParser.create(runtime.pyodide);

	// One legacy + one sqllens parser per adapter (they only differ by dialect).
	const legacyByAdapter = new Map<string, FtlDocumentParser>();
	const sqllensByAdapter = new Map<string, SqllensDocumentParser>();
	const parsers = (adapter: string): { legacy: FtlDocumentParser; sqllens: SqllensDocumentParser } => {
		const ctx: AdapterContext = { adapterType: adapter };
		let legacy = legacyByAdapter.get(adapter);
		if (!legacy) { legacy = new FtlDocumentParser(sqlParser, ctx); legacyByAdapter.set(adapter, legacy); }
		let sqllens = sqllensByAdapter.get(adapter);
		if (!sqllens) { sqllens = new SqllensDocumentParser(ctx); sqllensByAdapter.set(adapter, sqllens); }
		return { legacy, sqllens };
	};

	const reports: FileReport[] = [];
	let done = 0;
	for (const file of corpus) {
		const raw = fs.readFileSync(file.path, 'utf8');
		const { legacy, sqllens } = parsers(file.adapter);
		const report: FileReport = { label: file.label, adapter: file.adapter, diffs: [] };
		try {
			const legacyModel = await legacy.parse(raw);
			const sqllensModel = await sqllens.parse(raw);
			const pureSyntaxError =
				(legacyModel.sqlglotWarnings ?? []).some(w => w.type === 'syntax_error') ||
				(sqllensModel.sqlglotWarnings ?? []).some(w => w.type === 'syntax_error');
			const L = canonicalize(legacyModel, pureSyntaxError);
			const S = canonicalize(sqllensModel, pureSyntaxError);
			diffModels(L, S, report.diffs);
		} catch (err) {
			report.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
		}
		reports.push(report);
		done++;
		if (done % 10 === 0 || done === corpus.length) process.stdout.write(`  parsed ${done}/${corpus.length}\n`);
	}

	// --- Summary ---
	const clean = reports.filter(r => !r.error && r.diffs.length === 0);
	const errored = reports.filter(r => r.error);
	const dirty = reports.filter(r => !r.error && r.diffs.length > 0);

	const histogram = new Map<string, number>();
	for (const r of dirty) for (const d of r.diffs) {
		const k = histogramPath(d);
		histogram.set(k, (histogram.get(k) ?? 0) + 1);
	}
	const sortedHist = [...histogram.entries()].sort((a, b) => b[1] - a[1]);

	process.stdout.write('\n' + '='.repeat(60) + '\n');
	process.stdout.write('SHADOW-DIFF SUMMARY\n');
	process.stdout.write('='.repeat(60) + '\n');
	process.stdout.write(`  files scanned : ${reports.length}\n`);
	process.stdout.write(`  clean (0 diff): ${clean.length}\n`);
	process.stdout.write(`  with diffs    : ${dirty.length}\n`);
	process.stdout.write(`  errored       : ${errored.length}\n`);
	process.stdout.write(`  total diffs   : ${[...histogram.values()].reduce((a, b) => a + b, 0)}\n`);
	process.stdout.write('\n  Top diff field-paths:\n');
	for (const [k, n] of sortedHist.slice(0, 25)) process.stdout.write(`    ${n.toString().padStart(5)}  ${k}\n`);
	if (errored.length) {
		process.stdout.write('\n  Errored files:\n');
		for (const r of errored) process.stdout.write(`    ${r.label}: ${r.error}\n`);
	}

	writeReport(reports, clean.length, dirty.length, errored.length, sortedHist, args);
	process.stdout.write(`\nFull report written to ${path.relative(ROOT, REPORT_PATH)}\n`);

	// Report, not a gate.
	process.exit(0);
}

function writeReport(
	reports: FileReport[],
	clean: number,
	dirty: number,
	errored: number,
	hist: Array<[string, number]>,
	args: Args,
): void {
	fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
	const L: string[] = [];
	L.push('# Shadow-diff report — legacy (sqlglot/Pyodide) vs sqllens');
	L.push('');
	L.push(`Generated: ${new Date().toISOString()}`);
	L.push(`Corpus: ${args.dir ? `--dir ${args.dir}` : 'repo default (format fixtures + sample models)'}` +
		`${args.dialect ? ` --dialect ${args.dialect}` : ''} --max ${args.max}`);
	L.push('');
	L.push('## Summary');
	L.push('');
	L.push('| metric | count |');
	L.push('|---|---|');
	L.push(`| files scanned | ${reports.length} |`);
	L.push(`| clean (0 diff) | ${clean} |`);
	L.push(`| with diffs | ${dirty} |`);
	L.push(`| errored | ${errored} |`);
	L.push(`| total diffs | ${hist.reduce((a, b) => a + b[1], 0)} |`);
	L.push('');
	L.push('## Diff field-path histogram');
	L.push('');
	L.push('| count | field path |');
	L.push('|---|---|');
	for (const [k, n] of hist) L.push(`| ${n} | \`${k}\` |`);
	L.push('');
	L.push('## Per-file detail');
	L.push('');
	for (const r of reports) {
		if (!r.error && r.diffs.length === 0) continue;
		L.push(`### ${r.label}  _(${r.adapter})_`);
		L.push('');
		if (r.error) {
			L.push(`- **ERROR**: ${r.error}`);
			L.push('');
			continue;
		}
		for (const d of r.diffs) {
			const tag = d.kind ? ` _(${d.kind})_` : '';
			L.push(`- \`${d.path}\`${tag}`);
			L.push(`  - legacy:  ${trunc(d.legacy)}`);
			L.push(`  - sqllens: ${trunc(d.sqllens)}`);
		}
		L.push('');
	}
	fs.writeFileSync(REPORT_PATH, L.join('\n'), 'utf8');
}

main().catch(err => {
	process.stderr.write(`shadow-diff failed: ${err instanceof Error ? err.stack : String(err)}\n`);
	process.exit(1);
});
