/**
 * sqllens-native `DocumentParser` — builds the extension's `DocumentModel` from
 * the sqllens parser (native TypeScript, synchronous).
 *
 * The jinja front end is sqllens's own: `parseTemplated` segments the tags, runs
 * the SQL grammar over a length/newline-preserving placeholder (all spans stay in
 * raw-source coordinates), and returns the unified token stream + tag-AST this
 * parser consumes directly. sqllens is error-tolerant — a residual syntax error
 * yields a partial ast + diagnostics (surfaced as syntax_error warnings), never a
 * throw and never a fallback.
 *
 */
import type { DocumentModel, RefInfo, SourceInfo } from '../../services/parse-service';
import type { DocumentParser, ParseOptions } from '../../services/document-parser';
import type { DialectSymbols } from '../sql-tokens';
import { performance } from 'node:perf_hooks';
import { dialectSymbols, parseTemplated, qualify, resolveScopes, Schema, toSqllensDialect, type Dialect, type Qualification, type SchemaMapping, type SchemaProvider, type TemplateCall, type TemplatedParseOptions, type TemplatedParseResult, type TemplateProvider } from './api';
import { keywordTokenTypesFor, mapTokens } from './token-mapper';
import { mergeSqlAndJinjaTokens } from '../ninja-sql-tokens';
import { tagInfos } from './extract/tag-infos';
import { jinjaTokensFromStream } from './extract/jinja-stream';
import { compositeAstIndex, createSqllensAstIndex } from './ast-index';
import type { AstIndex } from '../../ninja/reflow/ast-index';
import { splitStatementsFromTemplated, type StatementRange } from '../../dbt/statement-splitter';
import { decompose } from './decompose';
import { traceColumnLineage, type LineageResult } from './lineage';
import { extractCtes } from './extract/ctes';
import { backfillSymAliases, extractSymbols } from './extract/symbols';
import { extractFinalColumns, extractFinalSelect } from './extract/final-select';
import { buildStarExpander } from './extract/star-expand';
import { mapDiagnostics, mapQualifyDiagnostics } from './extract/warnings';
import type { SqllensParse } from './extract/spans';

/**
 * The subset of ManifestIndexer the parser needs. `adapterType` selects the
 * sqllens dialect. `templateProvider` is the catalog seam (sqllens 4e1b18b): a
 * per-document `DefaultTemplateProvider` subclass answering what template calls
 * produce (manifest-sourced shape classification today; relations/values as we
 * climb). Reading the property constructs a fresh instance, so each parse gets
 * its own warm cache. Absent = the engine's shipped default behavior.
 * ManifestIndexer satisfies this structurally.
 */
export interface AdapterContext {
	readonly adapterType: string | undefined;
	readonly templateProvider?: TemplateProvider;
}

/**
 * Lowercased data type names — the canonical set used for type-aware
 * capitalization and identifier classification. The `DialectSymbols.types` contract
 * exposes dialect-independent and dialect-specific types. The type-capitalisation
 * consumers (reflow recase, cap-types rule) match bare identifier words against this
 * set, so its exact membership is behavior: `a.NAME` is recased because `name` is a
 * type member.
 */
const DATA_TYPE_NAMES: ReadonlySet<string> = new Set([
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
	/** Resolved symbol lists per sqllens dialect. Keyed by the sqllens `Dialect` and
	 *  holding the resolved value (sqllens is synchronous — no Promise to memoise).
	 *  Repeat calls return the identical `DialectSymbols` instance. */
	private readonly _symbolsCache = new Map<Dialect, DialectSymbols>();

	constructor(private readonly _context: AdapterContext) {}

	/**
	 * The dialect symbol lists the ninja capitalisation rules + reflow printer test
	 * mapped tokens against. All sets are LOWERCASE — every consumer does
	 * `set.has(x.toLowerCase())`, and the interface documents lowercase:
	 *   - `functions` — sqllens's own `dialectSymbols(dialect)` membership set
	 *     (canonical UPPERCASE), lowercased here.
	 *   - `keywordTokenTypes` — TokenType names the token-mapper can emit for
	 *     this dialect (`keywordTokenTypesFor`), lowercased. These are token `.type`
	 *     values (SELECT, ALIAS…), NOT keyword words, so sqllens's own `keywords` set
	 *     (grammar literals) is deliberately NOT used for them. Compound token types
	 *     (GROUP_BY, ORDER_BY, PARTITION_BY…) are FILTERED OUT: keyword recasing
	 *     never applies to compound tokens, so `GROUP BY` keeps its source casing,
	 *     and the format oracles encode that.
	 *   - `types` — the canonical set of data type names (dialect-INDEPENDENT),
	 *     provided as a static mirror (`DATA_TYPE_NAMES`). sqllens's
	 *     own per-dialect type-word set is deliberately not used: it both misses
	 *     canonical names the legacy recasing matched (`name`, `interval`, `map`…) and
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
				types: DATA_TYPE_NAMES,
			};
			this._symbolsCache.set(dialect, symbols);
		}
		return Promise.resolve(symbols);
	}

	/**
	 * Decompose compiled SQL into debug frames (CTEs + `_main_`) + per-frame stage
	 * clauses, JSON-stringified — the seam contract the debug adapter `JSON.parse`s
	 * (`debug-adapter.ts`). The free `decompose()` already documents this
	 * `JSON.stringify(decompose(...))` shape.
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
	 * `schemaJson` is the JSON catalog the caller stringifies
	 * (`JSON.stringify(schemaMapping)`), parsed back into the sqllens `SchemaMapping`;
	 * dialect resolves via `toSqllensDialect`, the same as `decomposeQuery`.
	 *
	 * sqllens's `traceColumnLineage` is total and never signals a structured failure
	 * itself. To populate the same union member, a thrown schema-parse / trace failure
	 * is caught and mapped to `{ error }`.
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
		// DocumentParser seam. `options.schema` (the qualify hint, a 2-level
		// `{ table: { column: type } }` map — assignable directly to sqllens's nested
		// `SchemaMapping`) feeds `SELECT *` expansion for PLAIN table names; when absent,
		// an EMPTY schema still expands CTE/subquery-sourced stars.
		// `options.templateProvider` (the enriched per-parse provider) wins over the
		// context's shape-only provider and doubles as qualify()'s SchemaProvider, so
		// templated ref()/source() sources resolve real warehouse columns.
		return Promise.resolve(this._parse(sql, options?.schema, options?.templateProvider));
	}

	private _parse(rawSql: string, schema?: Record<string, Record<string, string>>, enrichedProvider?: TemplateProvider): DocumentModel {
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
		//
		// provider (4e1b18b): statement/conjunct/CTE-body macro placeholders fill
		// shape-valid so macro-generated bodies parse natively; builtins keep the
		// default provider's answers. Undefined -> the engine's shipped default.
		// Read ONCE per document — every statement cell shares the same warm cache.
		const provider = enrichedProvider ?? this._context.templateProvider;
		const opts: TemplatedParseOptions | undefined = provider ? { provider } : undefined;
		const tp0 = performance.now();
		const templated = parseTemplated(rawSql, dialect, opts);
		const templatedMs = performance.now() - tp0;

		// A `;`-separated batch lowers to a flagged compound STUB (statement 1's
		// span, empty body — see the dialect lowerers' `flagged`), so whole-doc
		// extraction over it sees nothing. Split into statement cells with the
		// query editor's own jinja-aware splitter (ONE statement notion
		// extension-wide) and run the same pipeline per cell (`_parseCells`).
		// The `errors > 0` arm exists because a broken statement collapses the
		// batch in ANTLR recovery — the root then reports ONE element (`query`,
		// never `compound`) and the healthy statements after the `;` would be
		// silently dropped; with a split, each cell is error-tolerant on its own.
		// A clean single statement never enters (no compound flag, no errors), so
		// the hot path is untouched. A `BEGIN…END` scripting compound also flags
		// `compound`: with no top-level `;` it stays one cell and falls through
		// to the whole-doc stub (unchanged behavior); with inner `;`s the
		// splitter over-splits it into error-tolerant fragment parses — the same
		// view the query editor takes, and strictly more signal than the stub.
		if (templated.sql.ast.statement === 'compound' || templated.sql.errors > 0) {
			const ranges = splitStatementsFromTemplated(rawSql, templated);
			if (ranges.length > 1) return this._parseCells(rawSql, ranges, dialect, opts, schema, t0, templatedMs, provider);
		}

		return this._extract(rawSql, templated, dialect, schema, t0, templatedMs, provider);
	}

	/**
	 * Per-statement extraction for a multi-statement document. Each statement is
	 * parsed from a MASKED view of the whole document — the statement's own text
	 * in place, everything outside it blanked to spaces with newlines kept — so
	 * every span the pipeline produces is already in document coordinates and the
	 * per-cell models merge by plain concatenation (no shifting anywhere).
	 *
	 * Merge semantics: positional streams (tokens, ctes, refs, sources,
	 * macroCalls, warnings, jinja/ninja token streams) concatenate in source
	 * order. `finalSelect`/`finalColumns` describe the LAST statement that has a
	 * final select — a script's result set — and always describe the SAME
	 * statement. The legacy parser extracted statement 1 only; now we extract
	 * all statements using the same splitter as the query editor.
	 * The astIndex is the composite of the per-cell indexes — disjoint entry sets,
	 * so reflow keeps AST precision in every statement, not just the first.
	 */
	private _parseCells(
		rawSql: string,
		ranges: StatementRange[],
		dialect: Dialect,
		opts: TemplatedParseOptions | undefined,
		schema: Record<string, Record<string, string>> | undefined,
		t0: number,
		wholeDocParseMs: number,
		provider: TemplateProvider | undefined,
	): DocumentModel {
		let parseMs = wholeDocParseMs;
		const cells: DocumentModel[] = [];
		for (const r of ranges) {
			// Extend the cell window through its trailing `;`: the splitter's range
			// ends at the statement's last non-whitespace char, with only whitespace
			// between it and the split point. The separator must ride in exactly one
			// cell's token stream — masked everywhere, the formatter would emit the
			// document with its `;`s deleted (three statements become one).
			let end = r.endOffset;
			while (end < rawSql.length && /\s/.test(rawSql[end])) end++;
			end = rawSql[end] === ';' ? end + 1 : r.endOffset;
			const masked =
				rawSql.slice(0, r.startOffset).replace(/[^\r\n]/g, ' ')
				+ rawSql.slice(r.startOffset, end)
				+ rawSql.slice(end).replace(/[^\r\n]/g, ' ');
			const tp0 = performance.now();
			const templated = parseTemplated(masked, dialect, opts);
			const cellMs = performance.now() - tp0;
			parseMs += cellMs;
			cells.push(this._extract(masked, templated, dialect, schema, t0, cellMs, provider));
		}
		const final = [...cells].reverse().find(c => c.finalSelect !== undefined);
		const model: DocumentModel = {
			refs: cells.flatMap(c => c.refs),
			sources: cells.flatMap(c => c.sources),
			macroCalls: cells.flatMap(c => c.macroCalls ?? []),
			ctes: cells.flatMap(c => c.ctes),
			finalColumns: final?.finalColumns ?? [],
			finalSelect: final?.finalSelect,
			symbols: cells.flatMap(c => c.symbols ?? []),
			relationColumns: Object.assign({}, ...cells.map(c => c.relationColumns ?? {})) as Record<string, string[]>,
			parseWarnings: cells.flatMap(c => c.parseWarnings ?? []),
			timing: { parseMs: Math.round(parseMs), totalMs: Math.round(performance.now() - t0) },
			jinjaTokens: cells.flatMap(c => c.jinjaTokens ?? []),
			ninjaSqlTokens: cells.flatMap(c => c.ninjaSqlTokens ?? []),
		};
		model.astIndex = compositeAstIndex(cells.map(c => c.astIndex).filter((i): i is AstIndex => i !== undefined));
		return model;
	}

	/** The single-statement extraction pipeline over one `parseTemplated` result.
	 *  `text` is the source the parse's spans are keyed to — the raw document, or
	 *  a statement cell's masked view of it (`_parseCells`). */
	private _extract(
		text: string,
		templated: TemplatedParseResult,
		dialect: Dialect,
		schema: Record<string, Record<string, string>> | undefined,
		t0: number,
		templatedMs: number,
		provider: TemplateProvider | undefined,
	): DocumentModel {
		const ts0 = performance.now();
		const scopes = resolveScopes(templated.sql.ast, dialect);
		const parseMs = templatedMs + (performance.now() - ts0);
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
		const jinjaTokens = jinjaTokensFromStream(templated.tokens, templated.tags, text);

		// `SELECT *` expansion, UNGATED for every extractor (the cold-star middle
		// path): the expander runs qualify() (read-only; it never disturbs the
		// other extractors) over the parse's scopes. With a catalog it expands
		// table-sourced stars; with an EMPTY schema it still expands stars sourced
		// from CTEs / subqueries whose columns are structurally inferable — the
		// exact scope legacy's `infer_schema=True` covered without a catalog. What
		// changes vs legacy is the ANCHORING: expanded columns anchor star-exact
		// `[starCol, starEnd)` (star-expand.ts) instead of legacy's invented
		// `endCol - name.length` positions — a highlight covers the star
		// character, never text synthesized around it. A bare-table star with no
		// catalog entry stays unexpanded on both paths. Star diagnostics are NOT
		// mapped into warnings: nothing consumes a per-column star warning, so
		// surfacing them would be pure noise. The expander is undefined if qualify
		// throws — then every extractor falls back to unexpanded output.
		// The provider IS a SchemaProvider (duck-typed by design, channel 2026-07-10):
		// passing it to qualify() is what lets relationColumns/tableSourceColumns resolve
		// templated ref()/source() sources to real warehouse columns, and what scopes the
		// unknown-column diagnostics to positive answers only (open world, never-wrong).
		// The plain-Schema arm serves the compiled-SQL paths that pass `schema` without
		// a provider (lineage tool, decompose).
		const schemaObj: SchemaProvider = provider ?? new Schema((schema ?? {}) as SchemaMapping);
		// sqllens qualify is read-only — it never rewrites a bare column to add the qualifier
		// the legacy qualify did. extractTokens consumes this column→source binding to
		// resolve bare columns to their table. Fail-soft (undefined) to match the expander.
		let qualification: Qualification | undefined;
		try { qualification = qualify(result.scopes, schemaObj); } catch { /* alias-only resolution */ }
		const expander = qualification
			? buildStarExpander(result.scopes, schemaObj, qualification)
			: undefined;

		const ctes = extractCtes(result, expander);
		const symbols = extractSymbols(result.scopes, dialect, schemaObj, qualification?.expandStarOf);
		const finalColumns = extractFinalColumns(result, expander);
		const finalSelect = extractFinalSelect(result, expander);
		// refs + sources + macroCalls come from the R2 tag-AST (span-accurate; covers
		// the 2-arg `ref('pkg','model')` form; macroCalls carry nested calls since
		// sqllens `af1170c` — the expression `macro` node's `calls: MacroCall[]` is
		// symmetric to `control.calls`).
		const { refs, sources, macroCalls } = tagInfos(templated.tags);
		// The tag-AST sees jinja tags but never SQL aliases; back-fill them from
		// the matching relation Sym's own alias binding (position-matched).
		backfillSymAliases(symbols, refs, sources);

		// parseTemplated's placeholder is length-preserving, so token offsets line up
		// with `text` — mapTokens derives line starts from it.
		const sqlTokens = mapTokens(result.tokens, text, dialect);
		const ninjaSqlTokens = mergeSqlAndJinjaTokens(sqlTokens, jinjaTokens);
		// Scope warnings only over a CLEAN parse: a qualify verdict on a broken
		// statement is noise on top of the syntax error that explains it.
		const parseWarnings = [
			...mapDiagnostics(result.diagnostics),
			...(result.errors === 0 && qualification ? mapQualifyDiagnostics(qualification.diagnostics) : []),
		];

		const model: DocumentModel = {
			refs,
			sources,
			macroCalls,
			ctes,
			finalColumns,
			finalSelect,
			symbols,
			relationColumns: provider ? collectRelationColumns(refs, sources, provider) : {},
			parseWarnings,
			timing: { parseMs: Math.round(parseMs), totalMs: Math.round(performance.now() - t0) },
			jinjaTokens,
			ninjaSqlTokens,
		};

		// Build the reflow index straight off the parse's IR — the placeholder is
		// length-preserving, so IR char offsets align with `text` and the printer's
		// token stream. Multi-statement documents never reach this line as one
		// parse: `_parseCells` extracts per statement and composes the per-cell
		// indexes, so every statement keeps AST-index precision. The one residual
		// stub case is a `BEGIN…END` scripting compound with no top-level `;`
		// (single cell, flagged body) — its index carries the lone flagged-Select
		// entry and the printer falls back to token-stream passes inside it.
		model.astIndex = createSqllensAstIndex(result, text);

		return model;
	}
}

/**
 * Per-relation column lists from the provider's ref()/source() answers, keyed by
 * the templated source's IN-SCOPE name (lowercased) — the name the relation Sym
 * carries, so consumers (`ParseService.columnsForRef`) look up by `Sym.name`.
 * That name is the tag MARKER's logical name (sqllens apply-tags): the model
 * name for ref(), the dotted `source.table` pair for source(). Only POSITIVE
 * provider answers land — a cold or unresolvable relation contributes nothing,
 * never a fabricated list.
 */
function collectRelationColumns(refs: RefInfo[], sources: SourceInfo[], provider: TemplateProvider): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	const put = (key: string, call: TemplateCall): void => {
		const lc = key.toLowerCase();
		if (out[lc]) return;
		const cols = provider.expansion(call)?.relation?.columns;
		if (cols) out[lc] = cols.map(c => c.name);
	};
	for (const r of refs) put(r.model, { name: 'ref', args: [r.model] });
	for (const s of sources) put(`${s.sourceName}.${s.tableName}`, { name: 'source', args: [s.sourceName, s.tableName] });
	return out;
}
