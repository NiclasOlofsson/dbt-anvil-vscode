/**
 * sqllens-native `DocumentParser` — builds the extension's `DocumentModel` from
 * the sibling `sqllens` parser (native TypeScript, no Pyodide/sqlglot).
 *
 * It reuses the sqlglot path's jinja machinery unchanged: the raw source is
 * tokenised for `{{ ref }}` / `{{ source }}` / macro extraction, then the
 * three-pass blanking cascade (`parseWithJinjaFallback`) feeds SQL-safe text to
 * sqllens. The success predicate is "no syntax errors" (`errors === 0`), the
 * sqllens analog of the sqlglot path's `no syntax_error warnings`.
 *
 * Runs alongside `FtlDocumentParser` until cutover — neither touches the other.
 */
import type { DocumentModel } from '../../services/parse-service';
import type { DocumentParser, ParseOptions } from '../../services/document-parser';
import type { DialectSymbols } from '../sql-parser';
import { performance } from 'node:perf_hooks';
import { dialectSymbols, parse, resolveScopes, Schema, toSqllensDialect, type Dialect, type SchemaMapping } from './api';
import { tokenizeJinja } from '../jinja-tokenizer';
import { parseWithJinjaFallback, type ParsePass } from '../parse-with-jinja-fallback';
import { keywordTokenTypesFor, mapTokens } from './token-mapper';
import { mergeSqlAndJinjaTokens } from '../ninja-sql-tokens';
import { renToRawLine, type LineMap } from '../nunjucks-renderer';
import { extractMacroCalls, extractRefs, extractSources } from '../extractors/jinja-tag-extractors';
import { enrichTokensWithJinjaSpans } from '../extractors/jinja-token-enrichment';
import { createSqllensAstIndex } from './ast-index';
import { decompose } from './decompose';
import { traceColumnLineage, type LineageResult } from './lineage';
import { extractCtes } from './extract/ctes';
import { extractTokens } from './extract/tokens';
import { extractFinalColumns, extractFinalSelect } from './extract/final-select';
import { buildStarExpander } from './extract/star-expand';
import { mapDiagnostics } from './extract/warnings';
import type { SqllensParse } from './extract/spans';

/**
 * The subset of ManifestIndexer the parser needs — the active dbt adapter type,
 * which selects the sqllens dialect. ManifestIndexer satisfies it structurally.
 */
export interface AdapterContext {
	readonly adapterType: string | undefined;
}

export class SqllensDocumentParser implements DocumentParser {
	/** Resolved symbol lists per sqllens dialect. Mirrors FtlDocumentParser's
	 *  `_symbolsCache`, but keyed by the sqllens `Dialect` and holding the resolved
	 *  value (sqllens is synchronous — no Promise to memoise). Repeat calls return
	 *  the identical `DialectSymbols` instance. */
	private readonly _symbolsCache = new Map<Dialect, DialectSymbols>();

	constructor(private readonly _context: AdapterContext) {}

	/**
	 * The dialect symbol lists the ninja capitalisation rules + reflow printer test
	 * mapped tokens against. Shapes mirror the sqlglot path's `DialectSymbols`
	 * (LOWERCASE — every consumer does `set.has(x.toLowerCase())`, and the interface
	 * documents lowercase):
	 *   - `functions` / `types` — sqllens's own `dialectSymbols(dialect)` membership
	 *     sets (canonical UPPERCASE), lowercased here.
	 *   - `keywordTokenTypes` — sqlglot TokenType NAMES the token-mapper can emit for
	 *     this dialect (`keywordTokenTypesFor`), lowercased. These are token `.type`
	 *     values (SELECT, GROUP_BY, ALIAS…), NOT keyword words, so sqllens's own
	 *     `keywords` set (grammar literals) is deliberately NOT used for them.
	 */
	getDialectSymbols(): Promise<DialectSymbols | undefined> {
		const dialect = toSqllensDialect(this._context.adapterType);
		let symbols = this._symbolsCache.get(dialect);
		if (!symbols) {
			const s = dialectSymbols(dialect);
			const lower = (set: ReadonlySet<string>): ReadonlySet<string> =>
				new Set([...set].map(x => x.toLowerCase()));
			symbols = {
				functions: lower(s.functions),
				keywordTokenTypes: lower(keywordTokenTypesFor(dialect)),
				types: lower(s.types),
			};
			this._symbolsCache.set(dialect, symbols);
		}
		return Promise.resolve(symbols);
	}

	/**
	 * Decompose compiled SQL into debug frames (CTEs + `_main_`) + per-frame stage
	 * clauses, JSON-stringified — the seam contract the debug adapter `JSON.parse`s
	 * (`debug-adapter.ts`). Mirrors `FtlDocumentParser.decomposeQuery`; the free
	 * `decompose()` already documents this `JSON.stringify(decompose(...))` shape.
	 *
	 * Dialect resolves via `toSqllensDialect` (total — defaults to `databricks`), so
	 * unlike the legacy path there is no empty-string no-adapter branch: a real
	 * decompose is always produced. `decompose()` never throws — it reports slice
	 * failures as `{ success: false }` inside the JSON.
	 */
	decomposeQuery(compiledSql: string): Promise<string> {
		const dialect = toSqllensDialect(this._context.adapterType);
		return Promise.resolve(JSON.stringify(decompose(compiledSql, dialect)));
	}

	/**
	 * Trace column lineage for one output column, returning the same
	 * `LineageResult | { error }` union the seam (get-column-lineage tool) consumes.
	 * Mirrors `FtlDocumentParser.traceLineageV2`'s signature. `schemaJson` is the JSON
	 * catalog the caller stringifies (`JSON.stringify(schemaMapping)`), parsed back
	 * into the sqllens `SchemaMapping`; dialect resolves via `toSqllensDialect`, the
	 * same as `decomposeQuery`.
	 *
	 * sqllens's `traceColumnLineage` is total and never signals a structured failure
	 * itself (the legacy path's `{ error }` came from the pool's `success: false`
	 * result and a no-adapter guard). To populate the same union member here, a thrown
	 * schema-parse / trace failure is caught and mapped to `{ error }`.
	 */
	traceLineageV2(sql: string, columnName: string, schemaJson: string): Promise<LineageResult | { error: string }> {
		const dialect = toSqllensDialect(this._context.adapterType);
		try {
			const schema = JSON.parse(schemaJson) as SchemaMapping;
			return Promise.resolve(traceColumnLineage(sql, columnName, dialect, schema));
		} catch (err) {
			return Promise.resolve({ error: err instanceof Error ? err.message : String(err) });
		}
	}

	parse(sql: string, options?: ParseOptions): Promise<DocumentModel> {
		// sqllens is synchronous; the Promise-returning signature matches the
		// DocumentParser seam. `options.schema` (the sqlglot qualify hint, a 2-level
		// `{ table: { column: type } }` map — assignable directly to sqllens's nested
		// `SchemaMapping`) feeds `SELECT *` expansion; when absent, an EMPTY schema still
		// expands CTE/subquery-sourced stars, which is all the legacy path does without an
		// external catalog anyway (`infer_schema=True`).
		return Promise.resolve(this._parse(sql, options?.schema));
	}

	private _parse(rawSql: string, schema?: Record<string, Record<string, string>>): DocumentModel {
		const t0 = performance.now();
		const dialect = toSqllensDialect(this._context.adapterType);
		const jinjaTokens = tokenizeJinja(rawSql);

		let parseMs = 0;
		let pass1: SqllensParse | undefined;

		const runOnce = (passSql: string, p: ParsePass): SqllensParse => {
			const p0 = performance.now();
			const pr = parse(passSql, dialect);
			const scopes = resolveScopes(pr.ast, dialect);
			parseMs += performance.now() - p0;
			const res: SqllensParse = {
				ast: pr.ast,
				dialect,
				errors: pr.errors,
				diagnostics: pr.diagnostics,
				scopes,
				tokens: pr.tokens,
			};
			if (p === 'pass1') pass1 = res;
			return res;
		};

		const { result, pass, lineMap } = parseWithJinjaFallback(rawSql, runOnce, r => r.errors === 0);

		// On pass2 the parsed text is nunjucks-rendered (offsets shifted). Pass1's
		// blanking is length-preserving, so its token stream stays in raw-source
		// coordinates even when its parse failed — use it for the token streams,
		// exactly as the sqlglot path does.
		const tokenSource = (pass === 'pass2' && pass1) ? pass1 : result;

		// Schema-fed `SELECT *` expansion — wired ONLY when the caller supplies a schema.
		// The expander runs qualify() (read-only; it never disturbs the other extractors) over
		// the winning parse's scopes and, given a catalog, expands stars sourced from those
		// tables AND from CTEs/subqueries inferable from the same query. Gating on a non-empty
		// schema is deliberate: without a catalog the legacy path's synthesised columns carry
		// no real source token, so sqlglot anchors them via internal fall-backs (`line:0`, or
		// the FROM-table identifier) we cannot reproduce structurally — expanding then would
		// trade a name diff for a position diff, not close it. Star diagnostics are NOT mapped
		// into warnings: the legacy path emits no comparable per-column warning
		// (validate_qualify_columns=False), and scope_warnings are stripped before shadow
		// comparison, so surfacing them would be pure noise (EXTRACTOR-MAP §7). The expander is
		// also undefined if qualify throws — then every extractor falls back to unexpanded output.
		const expander = (schema && Object.keys(schema).length > 0)
			? buildStarExpander(result.scopes, new Schema(schema as SchemaMapping))
			: undefined;

		const ctes = extractCtes(result, expander);
		const tokens = extractTokens(result);
		const finalColumns = extractFinalColumns(result, expander);
		const finalSelect = extractFinalSelect(result, expander);
		const refs = extractRefs(jinjaTokens);
		const sources = extractSources(jinjaTokens);
		const macroCalls = extractMacroCalls(jinjaTokens);
		enrichTokensWithJinjaSpans(tokens, refs, sources);

		// blankJinja is length-preserving for pass1/pass1b, so tokenSource token
		// offsets line up with rawSql — mapTokens derives line starts from rawSql.
		const sqlTokens = mapTokens(tokenSource.tokens, rawSql, dialect);
		const ninjaSqlTokens = mergeSqlAndJinjaTokens(sqlTokens, jinjaTokens);
		const sqlglotWarnings = mapDiagnostics(result.diagnostics);

		const model: DocumentModel = {
			refs,
			sources,
			macroCalls,
			ctes,
			finalColumns,
			finalSelect,
			tokens,
			sqlglotWarnings,
			timing: { parseMs: Math.round(parseMs), totalMs: Math.round(performance.now() - t0) },
			jinjaTokens,
			ninjaSqlTokens,
			// `ast` stays undefined (the flat sqlglot serde payload) — the reflow
			// printer instead reads `astIndex`, built directly from the sqllens IR.
		};

		// Build the reflow index straight off the winning parse's IR. Only pass1/
		// pass1b are attached: their blanking is length-preserving so the IR char
		// offsets align with rawSql and the printer's token stream. A pass2 parse is
		// nunjucks-rendered (offsets shifted into rendered space), so its index would
		// mis-address the raw-space tokens — leave it undefined and let the reflow
		// path fall back to an empty index, matching the isPass2 gating used for the
		// model's other rendered-space positions.
		if (pass !== 'pass2') {
			model.astIndex = createSqllensAstIndex(result, rawSql);
		}

		if (pass === 'pass2') {
			// Pass2 positions are in rendered space; remap LINE numbers to raw source.
			// Columns are NOT remapped (rendered-space) — isPass2 tells consumers to
			// skip column-based ranges, matching the sqlglot path.
			remapModelLines(model, lineMap!);
			model.isPass2 = true;
		}

		return model;
	}
}

/** Remap every SQL-derived LINE number in the model from rendered to raw space. */
function remapModelLines(model: DocumentModel, lineMap: LineMap): void {
	const rl = (n: number): number => renToRawLine(n, lineMap);

	for (const cte of model.ctes) {
		cte.line = rl(cte.line);
		cte.endLine = rl(cte.endLine);
		for (const col of cte.columns) col.line = rl(col.line);
	}
	for (const tok of model.tokens) {
		tok.line = rl(tok.line);
		if (tok.type === 'column_ref') {
			if (tok.tableLine !== undefined) tok.tableLine = rl(tok.tableLine);
		} else if (tok.type === 'table_ref') {
			if (tok.aliasLine !== undefined) tok.aliasLine = rl(tok.aliasLine);
		}
	}
	for (const col of model.finalColumns) col.line = rl(col.line);
	if (model.finalSelect) {
		model.finalSelect.line = rl(model.finalSelect.line);
		model.finalSelect.endLine = rl(model.finalSelect.endLine);
		for (const c of model.finalSelect.columns) {
			c.line = rl(c.line);
			c.endLine = rl(c.endLine);
			if (c.aliasLine !== undefined) c.aliasLine = rl(c.aliasLine);
		}
	}
	for (const w of model.sqlglotWarnings ?? []) {
		if (w.line !== undefined) w.line = rl(w.line);
	}
}
