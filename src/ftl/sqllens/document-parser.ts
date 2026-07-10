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
import type { DocumentModel, ParseWarning } from '../../services/parse-service';
import type { DocumentParser, ParseOptions } from '../../services/document-parser';
import type { DialectSymbols } from '../sql-tokens';
import { performance } from 'node:perf_hooks';
import { dialectSymbols, minijinja, Schema, SqlDocument, toSqllensDialect, type Dialect, type Qualification, type SchemaMapping, type SchemaProvider, type Scope, type Sym, type TagNode, type TemplateProvider } from './api';
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

/** The one engine instance. Stateless strategy object (providers are passed per
 *  document at create), and sqllens keys its cross-edit cell cache on the engine
 *  name — a module singleton keeps that key stable across parses. */
const MINIJINJA = minijinja();

/** The per-arm documents of a templated doc, with each arm's realized text —
 *  the union views' own `arms()` rule: the real variants when they exist, else
 *  the document itself as the sole arm. */
function docArms(doc: SqlDocument, text: string): { doc: SqlDocument; text: string }[] {
	return doc.variants.length === 0
		? [{ doc, text }]
		: doc.variants.map(v => ({ doc: v.doc(), text: v.text() }));
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
		// ONE door (sqllens stage 3/variant wave): SqlDocument.create runs the
		// minijinja engine (length/newline-preserving fills, tag-AST, unified
		// stream), parses the primary all-text-live realization, and owns the
		// per-arm variant documents + the four union views the extractors below
		// consume. Templated ref/source relations are first-class sources named
		// after the REAL model, so scope/qualify/lineage bind under real names.
		// sqllens is error-tolerant — a residual syntax error yields a partial
		// ast + diagnostics, never a throw and never a fallback.
		//
		// provider (4e1b18b): statement/conjunct/CTE-body macro placeholders fill
		// shape-valid so macro-generated bodies parse natively, AND the provider
		// doubles as the SchemaProvider every analyze()/union view resolves
		// against — one object, both seams. Read ONCE per document.
		const provider = enrichedProvider ?? this._context.templateProvider;
		const schemaProvider: SchemaProvider = provider ?? new Schema((schema ?? {}) as SchemaMapping);
		const tp0 = performance.now();
		const doc = SqlDocument.create(rawSql, dialect, { templating: MINIJINJA, ...(provider ? { provider } : {}) });
		const parseMs = performance.now() - tp0;

		// A `;`-separated batch lowers to a flagged compound STUB, so whole-doc
		// extraction over it sees nothing. Split into statement cells with the
		// query editor's own jinja-aware splitter (ONE statement notion
		// extension-wide) and run the same pipeline per cell (`_parseCells`) —
		// this remains OUR path because templated multi-statement cell-splitting
		// is sqllens's ledgered follow-up, not yet theirs. The `errors > 0` arm
		// exists because a broken statement collapses the batch in ANTLR
		// recovery; with a split, each cell is error-tolerant on its own. A
		// clean single statement (every dbt model) never enters.
		if (doc.ast.statement === 'compound' || doc.errors > 0) {
			const ranges = splitStatementsFromTemplated(rawSql, doc.templated!);
			if (ranges.length > 1) return this._parseCells(rawSql, ranges, dialect, provider, schemaProvider, t0, parseMs);
		}

		return this._extract(rawSql, doc, dialect, schemaProvider, t0, parseMs);
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
		provider: TemplateProvider | undefined,
		schemaProvider: SchemaProvider,
		t0: number,
		wholeDocParseMs: number,
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
			const cellDoc = SqlDocument.create(masked, dialect, { templating: MINIJINJA, ...(provider ? { provider } : {}) });
			const cellMs = performance.now() - tp0;
			parseMs += cellMs;
			cells.push(this._extract(masked, cellDoc, dialect, schemaProvider, t0, cellMs));
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

	/** The single-statement extraction pipeline over one `SqlDocument`.
	 *  `text` is the source the doc's spans are keyed to — the raw document, or
	 *  a statement cell's masked view of it (`_parseCells`). Cross-arm facts come
	 *  from the document's UNION VIEWS (never our own merge — the variant wave's
	 *  contract); rich single-parse projections (finalSelect detail, CTE body
	 *  ranges, the reflow index) come from the primary parse and the per-arm
	 *  documents. */
	private _extract(
		text: string,
		doc: SqlDocument,
		dialect: Dialect,
		schemaProvider: SchemaProvider,
		t0: number,
		docMs: number,
	): DocumentModel {
		const ts0 = performance.now();
		const primary = sqllensParseOf(doc, dialect);
		const arms = docArms(doc, text);
		// jinjaTokens come from the SAME unified stream the SQL parse used (channel-2
		// minijinja island tokens), not a second independent lex.
		const jinjaTokens = jinjaTokensFromStream(doc.templated!.tokens, doc.templated!.tags, text);

		// The schema-dependent tier, fail-soft exactly like the old direct
		// qualify() call: `analyze()` runs qualify + deriveSymbols per arm
		// (memoized on provider identity+version); a throw degrades to
		// structural-only extraction, never a failed parse. The provider IS the
		// SchemaProvider (duck-typed by design), so templated ref()/source()
		// sources resolve real warehouse columns and unknown-column diagnostics
		// fire on positive answers only.
		let qualification: Qualification | undefined;
		try { qualification = doc.analyze(schemaProvider).qualification; } catch { /* structural-only */ }
		// `SELECT *` expansion for the rich primary projections (finalSelect
		// spans, CTE body extraction). Star-exact anchoring unchanged
		// (star-expand.ts). Union views run their own expansion per arm.
		const expander = qualification
			? buildStarExpander(doc.scopes, schemaProvider, qualification)
			: undefined;

		// Symbols and diagnostics: the document's cross-arm union views, deduped
		// by span+identity(+name) upstream — computed over the VARIANT docs only,
		// so conflicting-arm junk from the all-text-live primary never leaks in.
		// Degraded (qualification threw): structural symbols from the primary.
		let symbols: Sym[];
		let parseWarnings: ParseWarning[];
		if (qualification) {
			symbols = doc.unionSymbols(schemaProvider);
			const mixed = doc.unionDiagnostics(schemaProvider);
			const syntax = mixed.filter(d => !('kind' in d)) as Parameters<typeof mapDiagnostics>[0];
			const semantic = mixed.filter(d => 'kind' in d) as Parameters<typeof mapQualifyDiagnostics>[0];
			// Scope warnings only over a CLEAN parse: a qualify verdict on a broken
			// statement is noise on top of the syntax error that explains it.
			parseWarnings = [
				...mapDiagnostics([...syntax]),
				...(doc.errors === 0 ? mapQualifyDiagnostics(semantic) : []),
			];
		} else {
			symbols = extractSymbols(doc.scopes, dialect, schemaProvider, undefined);
			parseWarnings = mapDiagnostics(primary.diagnostics);
		}

		// CTEs: the RICH projection (body ranges, aliases, subquery entries) from
		// the primary parse; the cross-arm COLUMN union from `unionCtes` joined in
		// by name — the union view is authoritative for which columns exist, the
		// primary parse for everything else. A CTE visible only in a non-default
		// arm (conflicting arms broke its primary declaration) is recovered richly
		// from the first arm document that parses it.
		const ctes = extractCtes(primary, expander);
		if (qualification) {
			const richByName = new Map(ctes.map(c => [c.name.toLowerCase(), c]));
			for (const u of doc.unionCtes(schemaProvider)) {
				const columns = u.columns.map(col => ({ name: col.name, line: col.span.line - 1, col: col.span.column }));
				// An EMPTY union answer means the CTE's outputs are unresolvable
				// (a bare star over an undescribed relation, or a ledgered gap) —
				// keep the primary projection, whose literal `*` sentinel is
				// load-bearing: it is go-to-definition's jump target and the
				// "can't validate" marker for diagnostics/hover. Union authority
				// applies only where the union actually knows.
				if (columns.length === 0) continue;
				const rich = richByName.get(u.name.toLowerCase());
				if (rich) {
					rich.columns = columns;
					continue;
				}
				for (const arm of arms.slice(doc.variants.length === 0 ? 1 : 0)) {
					const armCtes = extractCtes(sqllensParseOf(arm.doc, dialect), undefined);
					const found = armCtes.find(c => c.name.toLowerCase() === u.name.toLowerCase());
					if (found) {
						found.columns = columns;
						ctes.push(found);
						richByName.set(u.name.toLowerCase(), found);
						break;
					}
				}
			}
		}

		// Final SELECT: output-column names from the cross-arm union view; the
		// rich per-column detail (expression/alias spans, complexity flags the
		// ninja rules consume) from the primary parse, falling back to the first
		// arm whose parse produced one when conflicting arms broke the primary's.
		// Same empty-answer rule as the CTE join: an unresolvable root star (or a
		// ledgered union-view gap) keeps the primary projection's `*` sentinel.
		const unionOutputs = qualification ? doc.unionOutputColumns(schemaProvider) : [];
		const finalColumns = unionOutputs.length > 0
			? unionOutputs.map(c => ({ name: c.name, line: c.span.line - 1, col: c.span.column }))
			: extractFinalColumns(primary, expander);
		let finalSelect = extractFinalSelect(primary, expander);
		if (!finalSelect && doc.variants.length > 0) {
			for (const arm of arms) {
				finalSelect = extractFinalSelect(sqllensParseOf(arm.doc, dialect), undefined);
				if (finalSelect) break;
			}
		}

		// refs + sources + macroCalls from the PRIMARY tag-AST — segmentation is
		// text-level, so it carries EVERY arm's tags (variant-wave A1); no union
		// needed. The tag-AST sees jinja tags but never SQL aliases; back-fill
		// them from each ARM's own guaranteed nodeOf ↔ Sym.node identity joins
		// (the primary's joins are best-effort under conflicting arms).
		const { refs, sources, macroCalls } = tagInfos(doc.templated!.tags);
		backfillSymAliases(refs, sources, doc.templated!.tags, arms.map(a => ({
			symbols: armSymbolsOf(a.doc, schemaProvider, dialect),
			tags: a.doc.templated!.tags,
			nodeOf: (t: TagNode) => a.doc.templated!.nodeOf(t),
		})));

		// The engine's placeholder is length-preserving, so token offsets line up
		// with `text` — mapTokens derives line starts from it.
		const sqlTokens = mapTokens(primary.tokens, text, dialect);
		const ninjaSqlTokens = mergeSqlAndJinjaTokens(sqlTokens, jinjaTokens);

		const model: DocumentModel = {
			refs,
			sources,
			macroCalls,
			ctes,
			finalColumns,
			finalSelect,
			symbols,
			relationColumns: qualification ? collectRelationColumns(arms, schemaProvider, dialect) : {},
			parseWarnings,
			timing: { parseMs: Math.round(docMs + (performance.now() - ts0)), totalMs: Math.round(performance.now() - t0) },
			jinjaTokens,
			ninjaSqlTokens,
		};

		// The reflow index: one per ARM document over that arm's realized text
		// (coordinate-preserving, so all indexes share document bytes), composed
		// byte-first — every arm's bytes keep AST precision, the same composition
		// mergeModels used to do across variant models.
		model.astIndex = compositeAstIndex(
			arms.map(a => createSqllensAstIndex(sqllensParseOf(a.doc, dialect), a.text)),
		);

		return model;
	}
}

/** The `SqllensParse` view of one document — the shape the rich single-parse
 *  extractors (ctes/final-select/ast-index) have always consumed. Token stream
 *  is the SQL-side stream (`templated.sql.tokens`), byte-identical to the
 *  pre-door pipeline's, so the ninja/reflow token behavior is unchanged. */
function sqllensParseOf(doc: SqlDocument, dialect: Dialect): SqllensParse {
	return {
		ast: doc.ast,
		dialect,
		errors: doc.errors,
		diagnostics: [...doc.diagnostics],
		scopes: doc.scopes,
		tokens: doc.templated!.sql.tokens,
	};
}

/** An arm's own analyzed symbols (arm-local `Sym.node` identities — the ones
 *  the arm's `nodeOf` joins are guaranteed against). Fail-soft to structural
 *  symbols, mirroring `_extract`'s degraded path. */
function armSymbolsOf(doc: SqlDocument, schemaProvider: SchemaProvider, dialect: Dialect): Sym[] {
	try { return doc.analyze(schemaProvider).symbols; } catch {
		return extractSymbols(doc.scopes, dialect, schemaProvider, undefined);
	}
}

/**
 * Per-relation column lists via sqllens's own `Qualification.columnsOfSource`
 * (stage-1 Of-accessor), walked over EVERY arm document so a relation living
 * only inside a non-default `{% else %}` arm still lands. Keys: the relation's
 * own name (lowercased; dotted for multi-part names) — the same name the
 * relation Sym carries, so consumers (`ParseService.columnsForRef`) look up by
 * `Sym.name`. First arm wins per key; "unknown" answers contribute nothing —
 * never a fabricated list. CTE-kind sources are skipped on purpose:
 * `model.ctes` already carries them, and a CTE shadows a same-named relation
 * in `columnsForRef`'s lookup order anyway.
 */
function collectRelationColumns(
	arms: { doc: SqlDocument }[],
	schemaProvider: SchemaProvider,
	dialect: Dialect,
): Record<string, string[]> {
	const out: Record<string, string[]> = {};
	for (const arm of arms) {
		let q: Qualification;
		try { q = arm.doc.analyze(schemaProvider).qualification; } catch { continue; }
		const visit = (scope: Scope): void => {
			for (const src of scope.sources.values()) {
				if (src.kind !== 'table') continue;
				const key = src.name.join('.').toLowerCase();
				if (out[key]) continue;
				const cols = q.columnsOfSource(scope, src);
				if (cols !== 'unknown') out[key] = cols.map(c => c.name);
			}
			for (const child of scope.children) visit(child);
		};
		visit(arm.doc.scopes.root);
	}
	void dialect;
	return out;
}
