/**
 * sqllens-native `DocumentParser` — builds the extension's `DocumentModel` from
 * the sibling `sqllens` parser (native TypeScript, no Pyodide/sqlglot).
 *
 * The jinja front end is sqllens's own: `parseTemplated` segments the tags, runs
 * the SQL grammar over a length/newline-preserving placeholder (all spans stay in
 * raw-source coordinates), and returns the unified token stream + tag-AST this
 * parser consumes directly. sqllens is error-tolerant — a residual syntax error
 * yields a partial ast + diagnostics (surfaced as syntax_error warnings), never a
 * throw and never a fallback.
 *
 * Runs alongside `FtlDocumentParser` until cutover — neither touches the other.
 */
import type { DocumentModel } from '../../services/parse-service';
import type { DocumentParser, ParseOptions } from '../../services/document-parser';
import type { DialectSymbols } from '../sql-parser';
import { performance } from 'node:perf_hooks';
import { dialectSymbols, parseTemplated, qualify, resolveScopes, Schema, toSqllensDialect, type Dialect, type Qualification, type SchemaMapping, type ShapeOf } from './api';
import { keywordTokenTypesFor, mapTokens } from './token-mapper';
import { mergeSqlAndJinjaTokens } from '../ninja-sql-tokens';
import { tagInfos } from './extract/tag-infos';
import { jinjaTokensFromStream } from './extract/jinja-stream';
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
 * The subset of ManifestIndexer the parser needs. `adapterType` selects the
 * sqllens dialect. `shapeOf` is the optional C4 template-catalog seam: a
 * synchronous macro-name -> expansion-shape lookup (sourced from the dbt manifest)
 * that lets `parseTemplated` fill a statement/CTE-body macro placeholder with a
 * shape-valid fragment instead of the identifier fill — so a macro-generated
 * query body parses natively instead of falling back to the blank cascade. Absent
 * = zero-catalog = byte-identical to the 2-arg parse. ManifestIndexer satisfies
 * this structurally.
 */
export interface AdapterContext {
	readonly adapterType: string | undefined;
	readonly shapeOf?: ShapeOf;
}

/**
 * Verbatim mirror of sqlglot's `DataType.Type` enum values, lowercased — the
 * `DialectSymbols.types` contract the legacy path exposed (`_get_dialect_symbols`
 * in resources/ftl/sql_parser.py enumerates every enum member, for EVERY
 * dialect). Captured from the live Pyodide parser (sqlglot vendored in
 * resources/ftl/vendor). The type-capitalisation consumers (reflow recase,
 * cap-types rule) match bare identifier words against this set, so its exact
 * membership is behavior: `a.NAME` is recased because `name` is an enum member.
 */
const SQLGLOT_DATA_TYPE_NAMES: ReadonlySet<string> = new Set([
	'aggregatefunction', 'array', 'bigdecimal', 'bigint', 'bignum', 'bigserial', 'binary', 'bit',
	'blob', 'boolean', 'bpchar', 'char', 'date', 'date32', 'datemultirange', 'daterange',
	'datetime', 'datetime2', 'datetime64', 'decfloat', 'decimal', 'decimal128', 'decimal256', 'decimal32',
	'decimal64', 'double', 'dynamic', 'enum', 'enum16', 'enum8', 'file', 'fixedstring',
	'float', 'geography', 'geographypoint', 'geometry', 'hllsketch', 'hstore', 'image', 'inet',
	'int', 'int128', 'int256', 'int4multirange', 'int4range', 'int8multirange', 'int8range', 'interval',
	'ipaddress', 'ipprefix', 'ipv4', 'ipv6', 'json', 'jsonb', 'linestring', 'list',
	'longblob', 'longtext', 'lowcardinality', 'map', 'mediumblob', 'mediumint', 'mediumtext', 'money',
	'multilinestring', 'multipolygon', 'name', 'nchar', 'nested', 'nothing', 'null', 'nummultirange',
	'numrange', 'nvarchar', 'object', 'point', 'polygon', 'range', 'ring', 'rowversion',
	'serial', 'set', 'simpleaggregatefunction', 'smalldatetime', 'smallint', 'smallmoney', 'smallserial', 'struct',
	'super', 'tdigest', 'text', 'time', 'time_ns', 'timestamp', 'timestamp_ms', 'timestamp_ns',
	'timestamp_s', 'timestampltz', 'timestampntz', 'timestamptz', 'timetz', 'tinyblob', 'tinyint', 'tinytext',
	'tsmultirange', 'tsrange', 'tstzmultirange', 'tstzrange', 'ubigint', 'udecimal', 'udouble', 'uint',
	'uint128', 'uint256', 'umediumint', 'union', 'unknown', 'user-defined', 'usmallint', 'utinyint',
	'uuid', 'varbinary', 'varchar', 'variant', 'vector', 'xml', 'year',
]);

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
	 *   - `functions` — sqllens's own `dialectSymbols(dialect)` membership set
	 *     (canonical UPPERCASE), lowercased here.
	 *   - `keywordTokenTypes` — sqlglot TokenType NAMES the token-mapper can emit for
	 *     this dialect (`keywordTokenTypesFor`), lowercased. These are token `.type`
	 *     values (SELECT, ALIAS…), NOT keyword words, so sqllens's own `keywords` set
	 *     (grammar literals) is deliberately NOT used for them. Mirroring the legacy
	 *     `_get_dialect_symbols` (sql_parser.py — `if name.isalpha()`), names that are
	 *     not purely alphabetic (GROUP_BY, ORDER_BY, PARTITION_BY…) are FILTERED OUT:
	 *     legacy keyword recasing never saw compound token types, so `GROUP BY`
	 *     keeps its source casing, and the format oracles encode that.
	 *   - `types` — the legacy contract is sqlglot's `DataType.Type` enum names,
	 *     dialect-INDEPENDENT (`_get_dialect_symbols` enumerates the whole enum), so
	 *     the same static mirror (`SQLGLOT_DATA_TYPE_NAMES`) is used here. sqllens's
	 *     own per-dialect type-word set is deliberately not used: it both misses
	 *     enum names the legacy recasing matched (`name`, `interval`, `map`…) and
	 *     adds dialect aliases legacy never recased (`int4`, `string`…).
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
				keywordTokenTypes: new Set(
					[...keywordTokenTypesFor(dialect)]
						.map(x => x.toLowerCase())
						.filter(x => /^[a-z]+$/.test(x)),
				),
				types: SQLGLOT_DATA_TYPE_NAMES,
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
		// The one parse: parseTemplated segments the jinja (inc1 unified stream + inc2
		// R3 tag-applied ast), runs the SQL grammar over a length/newline-preserving
		// placeholder (all spans stay in raw-source coordinates), and its ast carries
		// templated ref/source relations as first-class sources named after the REAL
		// model (`template` marker set), so the extractors + scope/qualify/lineage bind
		// under real names. No-output builtins (config/docs/...) placeholder to
		// whitespace, so config-topped models parse. A residual syntax error yields a
		// partial ast + diagnostics (mapped to syntax_error warnings below) — sqllens
		// is error-tolerant by design; the legacy blank/render cascade is gone.
		const tp0 = performance.now();
		// shapeOf (C4): statement/CTE-body macro placeholders fill shape-valid so
		// macro-generated bodies parse natively. Undefined -> zero-catalog, byte-identical.
		const templated = parseTemplated(rawSql, dialect, { shapeOf: this._context.shapeOf });
		const scopes = resolveScopes(templated.sql.ast, dialect);
		const parseMs = performance.now() - tp0;
		const result: SqllensParse = {
			ast: templated.sql.ast,
			dialect,
			errors: templated.sql.errors,
			diagnostics: templated.sql.diagnostics,
			scopes,
			tokens: templated.sql.tokens,
		};
		// jinjaTokens come from the SAME unified stream the SQL parse used (channel-2
		// minijinja island tokens), not a second independent lex.
		const jinjaTokens = jinjaTokensFromStream(templated.tokens, templated.tags, rawSql);

		// Schema-fed `SELECT *` expansion. For the COLUMN-list extractors (ctes /
		// finalColumns / finalSelect) it is wired ONLY when the caller supplies a schema.
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
		const schemaObj = new Schema((schema ?? {}) as SchemaMapping);
		// sqllens qualify is read-only — it never rewrites a bare column to add the qualifier
		// sqlglot's mutating qualify did. extractTokens consumes this column→source binding to
		// resolve bare columns to their table. Fail-soft (undefined) to match the expander.
		let qualification: Qualification | undefined;
		try { qualification = qualify(result.scopes, schemaObj); } catch { /* alias-only resolution */ }
		// TOKEN star expansion is UNGATED (empty schema still expands CTE/subquery-sourced
		// stars): legacy qualify ran with infer_schema=True unconditionally, so the token
		// stream carried synthetic column_refs for star-consumed CTE columns with or without
		// a catalog — the unused-columns rule depends on them. Token spans are zero-width
		// (extractTokens Pass 3), so the position-anchoring concern gating `expander` below
		// does not apply here. Reuses `qualification` rather than running qualify() again.
		const tokenStarExpander = qualification
			? buildStarExpander(result.scopes, schemaObj, qualification)
			: undefined;
		const expander = (schema && Object.keys(schema).length > 0)
			? tokenStarExpander
			: undefined;

		const ctes = extractCtes(result, expander);
		const tokens = extractTokens(result, qualification, tokenStarExpander);
		const finalColumns = extractFinalColumns(result, expander);
		const finalSelect = extractFinalSelect(result, expander);
		// refs + sources + macroCalls come from the R2 tag-AST (span-accurate; covers
		// the 2-arg `ref('pkg','model')` form; macroCalls carry nested calls since
		// sqllens `af1170c` — the expression `macro` node's `calls: MacroCall[]` is
		// symmetric to `control.calls`).
		const { refs, sources, macroCalls } = tagInfos(templated.tags, rawSql);
		enrichTokensWithJinjaSpans(tokens, refs, sources);

		// parseTemplated's placeholder is length-preserving, so token offsets line up
		// with rawSql — mapTokens derives line starts from rawSql.
		const sqlTokens = mapTokens(result.tokens, rawSql, dialect);
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

		// Build the reflow index straight off the parse's IR — the placeholder is
		// length-preserving, so IR char offsets align with rawSql and the printer's
		// token stream.
		//
		// Multi-statement sources: sqllens parses statement 1 only, and since upstream
		// 2428f56 its CST span is BOUNDED to statement 1 on ALL 8 dialects (independently
		// probed 2026-07-05; guarded upstream by an all-dialect span test). Indexing is
		// therefore safe: statement 1 gets AST-index precision, later statements have no
		// enclosure and fall back to the printer's token-stream passes. (The former
		// sqllens-multistmt-span workaround is retired.)
		model.astIndex = createSqllensAstIndex(result, rawSql);

		return model;
	}
}
