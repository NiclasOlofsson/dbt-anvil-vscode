import * as vscode from 'vscode';
import type { DescribeCache } from '../dbt/describe-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { parseTemplated, templateVariants, toSqllensDialect } from '../ftl/sqllens/api';
import { resolveTagRelations } from '../providers/common/jinja-utils';
import type { ILogger } from '../types/logger';
import type { DocumentParser } from './document-parser';
import type { JinjaToken } from '../ftl/sql-tokens';
import type { AstIndex } from '../ninja/reflow/ast-index';
import { compositeAstIndex } from '../ftl/sqllens/ast-index';
import type { NinjaSqlToken } from '../ftl/ninja-sql-tokens';
import type { Span, Sym } from '../ftl/sqllens/api';
import type { SymbolBindings } from '../ftl/sqllens/extract/symbols';

export interface ColumnInfo {
	name: string;
	/** 0-based line of the column expression in the document */
	line: number;
	/** 0-based start column of the column name identifier (absent if position unavailable) */
	col?: number;
}

export interface CteInfo {
	name: string;
	/** 0-based line of the CTE name token in the document */
	line: number;
	/** 0-based start column of the CTE name token (absent if position unavailable) */
	col?: number;
	/** 0-based line of the closing paren of the CTE body */
	endLine: number;
	/** 0-based exclusive end column of the closing paren (absent if paren not found) */
	endCol?: number;
	columns: ColumnInfo[];
	/** SQL alias used in FROM/JOIN, e.g. `addr` in `FROM address_with_country addr` */
	alias?: string;
	/** True when this entry represents a subquery alias rather than a WITH-clause CTE */
	isSubquery?: boolean;
}

export interface RefInfo {
	model: string;
	/** 0-based line */
	line: number;
	/** 0-based column of the start of the ref() call */
	col: number;
	/** Table alias used in FROM/JOIN, e.g. `ss` in `{{ ref('model') }} ss` */
	alias?: string;
	/** 0-based column start of the model name string content (quotes excluded) */
	modelCol?: number;
	/** 0-based exclusive column end of the model name string content */
	modelEndCol?: number;
	/** 0-based column start of the full {{ ref(...) }} jinja tag */
	jinjaCol?: number;
	/** 0-based exclusive column end of the full {{ ref(...) }} jinja tag */
	jinjaEndCol?: number;
}

export interface SourceInfo {
	sourceName: string;
	tableName: string;
	/** 0-based line */
	line: number;
	/** 0-based column of the start of the source() call */
	col: number;
	/** Table alias used in FROM/JOIN, e.g. `s` in `{{ source('x','y') }} s` */
	alias?: string;
	/** 0-based column start of the sourceName string content (quotes excluded) */
	sourceNameCol?: number;
	/** 0-based exclusive column end of the sourceName string content */
	sourceNameEndCol?: number;
	/** 0-based column start of the tableName string content (quotes excluded) */
	tableNameCol?: number;
	/** 0-based exclusive column end of the tableName string content */
	tableNameEndCol?: number;
	/** 0-based column start of the full {{ source(...) }} jinja tag */
	jinjaCol?: number;
	/** 0-based exclusive column end of the full {{ source(...) }} jinja tag */
	jinjaEndCol?: number;
}

export interface MacroCallArgInfo {
	/** 0-based line of the argument */
	line: number;
	/** 0-based start column of the argument expression */
	col: number;
	/** 0-based exclusive end column of the argument expression */
	endCol: number;
}

export interface MacroCallInfo {
	/** Bare macro name (e.g. `pivot` in `{{ dbt_utils.pivot() }}`) */
	name: string;
	/** Package qualifier when called as `package.name(...)` */
	packageName?: string;
	/** 0-based line of the bare macro identifier */
	line: number;
	/** 0-based start column of the bare macro identifier */
	col: number;
	/** 0-based exclusive end column of the bare macro identifier */
	endCol: number;
	/** 0-based start column of the package qualifier identifier (when present) */
	packageCol?: number;
	/** 0-based exclusive end column of the package qualifier identifier */
	packageEndCol?: number;
	/** 0-based column start of the full enclosing jinja tag (`{{` or `{%`) */
	jinjaCol: number;
	/** 0-based exclusive column end of the full enclosing jinja tag */
	jinjaEndCol: number;
	/** 0-based line of the enclosing jinja tag opener */
	jinjaLine: number;
	/** 0-based column of the opening paren */
	argsCol?: number;
	/** 0-based exclusive column of the closing paren (when complete) */
	argsEndCol?: number;
	/** Per-argument spans, in source order. Empty when no args or call is incomplete. */
	args: MacroCallArgInfo[];
}

export interface ColumnRefToken {
	type: 'column_ref';
	name: string;
	/** 0-based line */
	line: number;
	/** 0-based inclusive start column */
	col: number;
	/** 0-based exclusive end column */
	endCol: number;
	/** Table/alias qualifier, e.g. `o` in `o.order_id` */
	table?: string;
	tableLine?: number;
	tableCol?: number;
	tableEndCol?: number;
	/**
	 * The table_ref token that this column's qualifier resolves to.
	 * Populated by the bridge post-processing pass — avoids every provider
	 * having to re-implement alias → definition-site lookup logic.
	 */
	resolvedTableRef?: TableRefToken;
}

export interface TableRefToken {
	type: 'table_ref';
	name: string;
	line: number;
	col: number;
	endCol: number;
	/** SQL alias, e.g. `o` in `FROM orders o` */
	alias?: string;
	aliasLine?: number;
	aliasCol?: number;
	aliasEndCol?: number;
	/**
	 * True when this token represents a CTE definition site (the `name` in
	 * `WITH name AS (...)`), not a FROM/JOIN reference. These should not be
	 * flagged by aliasing rules that apply to FROM/JOIN table references.
	 */
	cteDefinition?: true;
	/**
	 * True when this token was emitted for a subquery alias (`(SELECT ...) AS x`).
	 * The token's `name` and `alias` are both the alias identifier — there is no
	 * underlying table name being renamed, so self-alias checks must not fire.
	 */
	isSubquery?: true;
}

export interface ColumnDefToken {
	type: 'column_def';
	name: string;
	line: number;
	col: number;
	endCol: number;
}

export type TokenInfo = ColumnRefToken | TableRefToken | ColumnDefToken;

/**
 * Result of resolving a cursor position against the AST token map.
 * Tells the caller exactly what the cursor is sitting on.
 */
export type PositionResolution =
	| { kind: 'column'; token: ColumnRefToken }
	| { kind: 'table_qualifier'; token: ColumnRefToken }
	| { kind: 'table_ref'; token: TableRefToken }
	| { kind: 'table_alias'; token: TableRefToken }
	| { kind: 'column_def'; token: ColumnDefToken };

/**
 * A structural issue detected during parsing.
 *
 * - `scope_warning`: SQL parsed OK but scope analysis failed
 *   (e.g. a bare identifier before the CTE body). `cteName` is set.
 * - `syntax_error`: outright parse failure (typo, missing keyword, etc.).
 *   `cteName` is absent; `line`/`col`/`endCol` point at the bad token.
 */
export interface ParseWarning {
	/** Discriminates between structural scope issues and outright syntax errors */
	type: 'scope_warning' | 'syntax_error';
	/** Full warning message */
	message: string;
	/** CTE name the warning refers to, if extractable */
	cteName?: string;
	/** 0-based line number to point the diagnostic at */
	line?: number;
	/** 0-based start column of the bad token (when available) */
	col?: number;
	/** 0-based end column of the bad token (when available) */
	endCol?: number;
}

export interface FinalSelectColumnInfo {
	/** Output column name (alias or bare column name). */
	name: string;
	/** 0-based line of the start of the full expression (qualifier through alias). */
	line: number;
	/** 0-based start column of the full expression. */
	col: number;
	/** 0-based line of the end of the full expression. */
	endLine: number;
	/** 0-based exclusive end column of the full expression. */
	endCol: number;
	/** Source column name without qualifier or alias (e.g. "company_id"). */
	expression?: string;
	/** Table qualifier / alias (e.g. "co" in `co.company_id`). */
	table?: string;
	/** 0-based line of the alias identifier (AS clause only). */
	aliasLine?: number;
	/** 0-based start column of the alias identifier. */
	aliasCol?: number;
	/** 0-based exclusive end column of the alias identifier. */
	aliasEndCol?: number;
	/**
	 * True when this column is a non-trivial expression (function call, case,
	 * arithmetic, etc.) and therefore a candidate for the
	 * `aliasing.expression-no-alias` rule. False / absent for bare column
	 * references (including those synthesized from `select *` expansion).
	 *
	 * The `expression` field above carries the source identifier for bare
	 * columns too — it's used by alias-mismatch rules — so it can't double
	 * as a flag for "is this an expression worth aliasing." Hence this
	 * separate marker, set by the extractor on the exprNode shape.
	 */
	isComplexExpression?: boolean;
}

export interface FinalSelectInfo {
	/** 0-based line of the SELECT keyword. */
	line: number;
	/** 0-based start column of the SELECT keyword. */
	col: number;
	/** 0-based line of the last token in the SELECT clause. */
	endLine: number;
	/** 0-based exclusive end column of the last token. */
	endCol: number;
	columns: FinalSelectColumnInfo[];
}

export interface DocumentModel {
	ctes: CteInfo[];
	refs: RefInfo[];
	sources: SourceInfo[];
	/**
	 * User-defined macro call sites discovered in jinja `{{ }}` and `{% %}`
	 * tags. Populated by `extractMacroCalls`; absent (rather than empty) only
	 * on synthetic / test fixture models. Real parser output always sets it.
	 */
	macroCalls?: MacroCallInfo[];
	finalColumns: ColumnInfo[];
	/** Rich positional data for the final SELECT (replaces finalColumns over time). */
	finalSelect?: FinalSelectInfo;
	tokens: TokenInfo[];
	/**
	 * sqllens's native symbol model (Sym wave 2's successor to `tokens`). Absent only
	 * on synthetic / test fixture models that hand-build a DocumentModel directly;
	 * real parser output always sets it alongside `symbolBindings`.
	 */
	symbols?: Sym[];
	/**
	 * The relation-alias and column-source correlations `Sym` itself doesn't carry
	 * (see extract/symbols.ts) — computed once per parse, alongside `symbols`.
	 */
	symbolBindings?: SymbolBindings;
	timing: { parseMs: number; totalMs: number };
	/**
	 * Parse status. 'syntax_error' means the model's structural data (ctes, tokens, etc.) is
	 * carried over from the last good parse — only parseWarnings reflects the current state.
	 */
	status?: 'ok' | 'syntax_error';
	/** Structural warnings from parsing and scope analysis. */
	parseWarnings?: ParseWarning[];
	/**
	 * Alias → column-name map returned by the bridge after schema-aware parsing.
	 * `undefined` only when enrichment is not configured; otherwise always a dict
	 * (empty when schema_mapping had no entries for the upstream tables).
	 */
	aliases?: Record<string, string[]>;
	/**
	 * Flat fine-grained jinja token stream. Used by jinja-aware extractors
	 * and by the debug adapter to emit ref/source/macro markers.
	 */
	jinjaTokens?: JinjaToken[];
	/**
	 * Unified position-ordered stream interleaving SQL tokens and jinja tokens.
	 * Each entry carries a `category` discriminator (`'sql'` | `'jinja'`).
	 * This is the canonical surface for any consumer that wants a single
	 * token sequence covering both SQL and jinja content. SQL tokens that
	 * fall inside jinja regions (the blanker's placeholder substitutions)
	 * are filtered out — the jinja stream is authoritative there.
	 */
	ninjaSqlTokens?: NinjaSqlToken[];
	/**
	 * Byte-range structural index for the reflow printer, built by the parser
	 * from its IR/CST spans. The printer consults it to make clause-aware
	 * layout decisions (comma-position, indented_on, CTE body break) instead
	 * of inferring structure from token-stream heuristics.
	 *
	 * When a file has Jinja conditionals, `mergeModels` composes the variants'
	 * indexes so each branch keeps structural coverage at its own bytes.
	 */
	astIndex?: AstIndex;
}

/**
 * Optional dependencies for schema-aware parsing.
 * When provided, ParseService will describe upstream tables before calling
 * the bridge, so the bridge can resolve alias → column mappings in a single pass.
 */
export interface EnrichmentConfig {
	describeCache: DescribeCache;
	indexer: ManifestIndexer;
}

interface CacheEntry {
	version: number;
	model: DocumentModel;
}

/**
 * Whether (line, col) — 0-based, the extension's convention — falls inside a
 * sqllens `Span` (1-based line, 0-based column, end-exclusive). Returns a
 * comparable "width" when it does (smaller = a more specific match — used by
 * `ParseService.symAtPosition` to prefer the innermost covering symbol),
 * `undefined` when it doesn't.
 */
function symSpanContains(span: Span, line: number, col: number): number | undefined {
	const startLine = span.line - 1;
	const endLine = span.endLine - 1;
	if (line < startLine || line > endLine) return undefined;
	if (line === startLine && col < span.column) return undefined;
	if (line === endLine && col >= span.endColumn) return undefined;
	return (endLine - startLine) * 1_000_000 + (span.endColumn - span.column);
}

/** A `Sym` kind that `relationSymbol` (sqllens's own symbol emitter) can produce for a
 *  FROM/JOIN source or CTE reference — every kind that can carry an alias via `aliasOf`. */
function isRelationSym(sym: Sym): boolean {
	return (sym.kind === 'table' || sym.kind === 'cte' || sym.kind === 'subquery' || sym.kind === 'lateral')
		&& sym.modifiers.includes('reference');
}

/**
 * Merge N DocumentModels produced by separate bridge parse calls (one per SQL
 * variant) into a single model. All positions in each model are expressed in
 * original-source coordinates (variant realization is length-preserving), so
 * tokens from different variants can be combined without any remapping.
 */
export function mergeModels(models: DocumentModel[]): DocumentModel {
	if (models.length === 1) return models[0];

	// CTEs: union by name; within the same CTE merge column lists by name
	const cteMap = new Map<string, CteInfo>();
	for (const m of models) {
		for (const cte of m.ctes) {
			const existing = cteMap.get(cte.name);
			if (!existing) {
				cteMap.set(cte.name, { ...cte, columns: [...cte.columns] });
			} else {
				const known = new Set(existing.columns.map(c => c.name));
				for (const col of cte.columns) {
					if (!known.has(col.name)) {
						existing.columns.push(col);
						known.add(col.name);
					}
				}
			}
		}
	}

	// refs: dedup by model:line:col
	const refKeys = new Set<string>();
	const refs: RefInfo[] = [];
	for (const m of models) {
		for (const ref of m.refs) {
			const k = ref.model + ':' + ref.line + ':' + ref.col;
			if (!refKeys.has(k)) { refKeys.add(k); refs.push(ref); }
		}
	}

	// sources: dedup by sourceName:tableName:line:col
	const srcKeys = new Set<string>();
	const sources: SourceInfo[] = [];
	for (const m of models) {
		for (const src of m.sources) {
			const k = src.sourceName + ':' + src.tableName + ':' + src.line + ':' + src.col;
			if (!srcKeys.has(k)) { srcKeys.add(k); sources.push(src); }
		}
	}

	// macroCalls: dedup by name:line:col (packageName included to keep
	// `dbt_utils.pivot` distinct from a same-named bare `pivot`)
	const macroKeys = new Set<string>();
	const macroCalls: MacroCallInfo[] = [];
	for (const m of models) {
		for (const mc of (m.macroCalls ?? [])) {
			const k = (mc.packageName ?? '') + ':' + mc.name + ':' + mc.line + ':' + mc.col;
			if (!macroKeys.has(k)) { macroKeys.add(k); macroCalls.push(mc); }
		}
	}

	// tokens: dedup by type:line:col
	const tokKeys = new Set<string>();
	const tokens: TokenInfo[] = [];
	for (const m of models) {
		for (const tok of m.tokens) {
			const k = tok.type + ':' + tok.line + ':' + tok.col;
			if (!tokKeys.has(k)) { tokKeys.add(k); tokens.push(tok); }
		}
	}

	// symbols: dedup by kind:frame:span, same shape as the tokens dedup above.
	// symbolBindings: union — each variant's Sym objects are distinct instances, so
	// there is no key collision merging their Map entries directly.
	const symKeys = new Set<string>();
	const symbols: Sym[] = [];
	const symbolBindings: SymbolBindings = { aliasOf: new Map(), sourceOf: new Map() };
	for (const m of models) {
		for (const sym of m.symbols ?? []) {
			const k = `${sym.kind}:${sym.frame}:${sym.span.line}:${sym.span.column}`;
			if (!symKeys.has(k)) { symKeys.add(k); symbols.push(sym); }
		}
		for (const [k, v] of m.symbolBindings?.aliasOf ?? []) symbolBindings.aliasOf.set(k, v);
		for (const [k, v] of m.symbolBindings?.sourceOf ?? []) symbolBindings.sourceOf.set(k, v);
	}

	// finalColumns: dedup by name
	const finalNames = new Set<string>();
	const finalColumns: ColumnInfo[] = [];
	for (const m of models) {
		for (const col of m.finalColumns) {
			if (!finalNames.has(col.name)) { finalNames.add(col.name); finalColumns.push(col); }
		}
	}

	// aliases: union per key
	const aliases: Record<string, string[]> = {};
	for (const m of models) {
		for (const [alias, cols] of Object.entries(m.aliases ?? {})) {
			if (!(alias in aliases)) {
				aliases[alias] = [...cols];
			} else {
				const seen = new Set(aliases[alias]);
				for (const c of cols) { if (!seen.has(c)) { aliases[alias].push(c); seen.add(c); } }
			}
		}
	}

	// parseWarnings: dedup by message
	const warnMessages = new Set<string>();
	const parseWarnings: ParseWarning[] = [];
	for (const m of models) {
		for (const w of (m.parseWarnings ?? [])) {
			if (!warnMessages.has(w.message)) { warnMessages.add(w.message); parseWarnings.push(w); }
		}
	}

	const timing = {
		parseMs: models.reduce((s, m) => s + m.timing.parseMs, 0),
		totalMs: models.reduce((s, m) => s + m.timing.totalMs, 0),
	};

	// finalSelect: take the first model that has one (variants produce the same select)
	const finalSelect = models.find(m => m.finalSelect)?.finalSelect;

	// jinjaTokens / ninjaSqlTokens: all variants are parsed from the same raw source
	// (variant realization is length-preserving), so every variant's token streams carry
	// the same positions. Take the first model that has them. Dropping them here
	// causes comment-span masking in layout rules to silently stop working for any
	// file that contains Jinja conditionals.
	const jinjaTokens = models.find(m => m.jinjaTokens)?.jinjaTokens;
	const ninjaSqlTokens = models.find(m => m.ninjaSqlTokens)?.ninjaSqlTokens;

	// astIndex: first-hit composite over the variants' indexes. Each variant's
	// index covers the shared bytes (outside any Jinja conditional) PLUS its
	// own active branches — non-active branches are blanked to spaces and
	// contribute nothing. Composing gives structural coverage for every
	// branch: shared bytes answer identically from any variant, branch bytes
	// answer only from the variant that parsed them.
	const indexes = models.map(m => m.astIndex).filter((i): i is AstIndex => i !== undefined);
	const astIndex = indexes.length > 0 ? compositeAstIndex(indexes) : undefined;

	return { ctes: [...cteMap.values()], refs, sources, macroCalls, finalColumns, finalSelect, tokens, timing, parseWarnings, aliases,
		symbols,
		symbolBindings,
		jinjaTokens,
		ninjaSqlTokens,
		astIndex,
	};
}

/**
 * Caches DocumentModel per document URI + version.
 * Call `getDocumentModel` from providers — returns a cached result if the
 * document hasn't changed since the last parse, otherwise invokes the bridge.
 *
 * Concurrent calls for the same (URI, version) share a single in-flight
 * promise — VS Code can fire provideDocumentSymbols several times at once
 * (outline, breadcrumbs, …) and without this deduplication each concurrent
 * call would issue its own bridge request before the first one populates
 * the cache.
 */
export class ParseService {
	private readonly _cache = new Map<string, CacheEntry>();
	private readonly _inflight = new Map<string, Promise<DocumentModel | null>>();

	private readonly _onAliasesReady = new vscode.EventEmitter<vscode.Uri>();
	readonly onAliasesReady = this._onAliasesReady.event;

	private readonly _onParseWarnings = new vscode.EventEmitter<{ uri: vscode.Uri; warnings: ParseWarning[] }>();
	/** Fired after each parse when structural warnings are detected (e.g. Aliases node type). */
	readonly onParseWarnings = this._onParseWarnings.event;

	constructor(
		private readonly _parser: DocumentParser,
		private readonly _logger: ILogger,
		private readonly _enrichment?: EnrichmentConfig,
	) {}

	/** Cache for dialect symbol fetch — stored as a Promise for dedup on concurrent calls. */
	private _symbolsPromise: Promise<import('../ftl/sql-tokens').DialectSymbols | undefined> | undefined;

	/**
	 * Return the authoritative symbol lists (functions, keyword token types, data types)
	 * for the active dialect. Fetched once and cached for the lifetime of this service.
	 * Returns undefined when the parser does not support symbol extraction.
	 */
	getDialectSymbols(): Promise<import('../ftl/sql-tokens').DialectSymbols | undefined> {
		if (!this._symbolsPromise) {
			this._symbolsPromise = this._parser.getDialectSymbols?.() ?? Promise.resolve(undefined);
		}
		return this._symbolsPromise;
	}

	/**
	 * Return the DocumentModel for the given document.
	 * Re-parses via the bridge only when the version has changed.
	 *
	 * When enrichment is configured, describes all upstream refs before calling
	 * the bridge so aliases are fully populated in the returned model.
	 * Pass `skipEnrichment: true` to skip database describe calls (e.g. for
	 * structural-only use cases like profiling where only CTE positions matter).
	 */
	async getDocumentModel(
		document: vscode.TextDocument,
		{ skipEnrichment = false }: { skipEnrichment?: boolean } = {},
	): Promise<DocumentModel | null> {
		const key = document.uri.toString();
		const cached = this._cache.get(key);
		if (cached && cached.version === document.version) {
			return cached.model;
		}

		// Deduplicate concurrent requests for the same version.
		const inflightKey = `${key}@${document.version}`;
		const existing = this._inflight.get(inflightKey);
		if (existing) {
			return existing;
		}

		const promise = this._parse(document, key, skipEnrichment);
		this._inflight.set(inflightKey, promise);
		try {
			return await promise;
		} catch (err) {
			this._logger.error('[parse-service] bridge crash for ' + document.fileName + ': ' + String(err));
			// Return stale model if available so providers remain functional.
			return this._cache.get(key)?.model ?? null;
		} finally {
			this._inflight.delete(inflightKey);
		}
	}

	/**
	 * Find the CteInfo that a relation Sym refers to.
	 * When multiple CTEs share the same name (e.g. nested subqueries that
	 * reuse the same alias), the symbol's line position disambiguates:
	 * pick the CteInfo whose body range [line, endLine] contains it.
	 *
	 * A subquery-kind Sym's OWN span covers its whole source text (the entire
	 * `(SELECT ...)`, often multi-line) — anchoring disambiguation there would
	 * miss every CteInfo entry, whose `[line, endLine]` is just the alias's own
	 * line. Anchor on the alias Sym's line instead when one exists (matching
	 * the single-line anchor the retired TokenInfo bridge used for subqueries).
	 * Table/CTE-kind refs are unaffected — their own span already IS the
	 * name's line, same as before.
	 */
	static cteForRef(ref: Sym, model: DocumentModel): CteInfo | undefined {
		const nameLc = ref.name.toLowerCase();
		const alias = ref.kind === 'subquery' ? model.symbolBindings?.aliasOf.get(ref) : undefined;
		const line = (alias ?? ref).span.line - 1;
		const candidates = model.ctes.filter(c =>
			c.name.toLowerCase() === nameLc || c.alias?.toLowerCase() === nameLc,
		);
		if (candidates.length <= 1) return candidates[0];
		return candidates.find(c => line >= c.line && line <= c.endLine)
			?? candidates[candidates.length - 1];
	}

	/**
	 * Return the column list for the table that `ref` points to.
	 * Checks CTE projections first, then manifest-enriched aliases.
	 * Returns `undefined` when the table is not locally defined (e.g. an
	 * externally-defined CTE passed in by the macro caller).
	 */
	static columnsForRef(ref: Sym, model: DocumentModel): string[] | undefined {
		const nameLc = ref.name.toLowerCase();
		const cte = ParseService.cteForRef(ref, model);
		if (cte) return cte.columns.map(c => c.name);
		return model.aliases?.[ref.name] ?? model.aliases?.[nameLc];
	}

	/**
	 * Trace intra-model CTE lineage for a given relation Sym.
	 *
	 * Starting from `ref`, if it resolves to a CTE, follow the chain of
	 * relation symbols inside each CTE body to build an ordered list of names.
	 * Stops when a node is not a CTE (external ref, source, or plain table).
	 *
	 * Returns an empty array when `ref` is not a CTE.
	 *
	 * Example result: ['address_with_country', "ref('gold__address')"]
	 */
	static traceCteLineage(ref: Sym, model: DocumentModel): string[] {
		const cteByName = new Map(model.ctes.map(c => [c.name.toLowerCase(), c]));
		const symbols = model.symbols ?? [];
		const chain: string[] = [];
		const visited = new Set<string>();

		let current: Sym | undefined = ref;
		while (current) {
			const nameLc = current.name.toLowerCase();
			if (visited.has(nameLc)) break; // cycle guard
			visited.add(nameLc);

			const cte = cteByName.get(nameLc);
			if (!cte) {
				// Not a CTE — only append if chain is non-empty (we're mid-chain)
				if (chain.length > 0) chain.push(current.name);
				break;
			}

			chain.push(cte.name);

			// Find the first relation Sym inside this CTE's body range
			const next = symbols.find(s =>
				isRelationSym(s)
					&& (s.span.line - 1) >= cte.line
					&& (s.span.line - 1) <= cte.endLine,
			);
			if (!next) break;
			current = next;
		}

		// If the chain only resolved to the start CTE and nothing else was found,
		// check if there's an external table (ref/source) to append
		if (chain.length === 1) {
			const cte = cteByName.get(ref.name.toLowerCase())!;
			// Find any relation Sym in its body not already in chain
			const inner = symbols.find(s =>
				isRelationSym(s)
					&& (s.span.line - 1) >= cte.line
					&& (s.span.line - 1) <= cte.endLine
					&& !cteByName.has(s.name.toLowerCase()),
			);
			if (inner) {
				// Check if it's a ref()
				const refInfo = model.refs.find(r => r.line === inner.span.line - 1);
				chain.push(refInfo ? `ref('${inner.name}')` : inner.name);
			}
		} else if (chain.length > 1) {
			// For deeper chains: annotate the last entry if it's a ref()
			const last = chain[chain.length - 1];
			const isRef = model.refs.some(r => {
				const sym = symbols.find(s => isRelationSym(s) && s.name === last && r.line === s.span.line - 1);
				return !!sym;
			});
			if (isRef && !last.startsWith('ref(')) {
				chain[chain.length - 1] = `ref('${last}')`;
			}
		}

		// ref itself is not a CTE — build a direct chain from the ref token
		if (chain.length === 0) {
			const isRef = model.refs.some(r => r.model.toLowerCase() === ref.name.toLowerCase());
			const refStr = isRef ? `ref('${ref.name}')` : ref.name;
			return [refStr];
		}

		return chain;
	}

	/**
	 * Compute the combined alias → column-name map from a parsed model.
	 * Merges bridge-resolved upstream aliases (model.aliases) with CTE aliases
	 * and any FROM/JOIN aliases that point to CTEs.
	 */
	static resolveAliases(model: DocumentModel): Record<string, string[]> {
		const cteAliases: Record<string, string[]> = {};
		for (const cte of model.ctes) {
			const cols = cte.columns.map(c => c.name);
			cteAliases[cte.name] = cols;
			if (cte.alias) cteAliases[cte.alias] = cols;
		}
		// Resolve FROM/JOIN aliases that point to CTEs.
		// e.g. `LEFT JOIN address_with_country AS addr` — `addr` maps to that CTE's columns.
		for (const tok of model.tokens) {
			if (tok.type === 'table_ref' && tok.alias) {
				const aliasLc = tok.alias.toLowerCase();
				if (aliasLc in cteAliases) continue;
				const targetCols = cteAliases[tok.name.toLowerCase()];
				if (targetCols) cteAliases[aliasLc] = targetCols;
			}
		}
		return { ...cteAliases, ...(model.aliases ?? {}) };
	}

	/**
	 * Clear cached models only for documents that reference any of the given
	 * unique IDs. Unaffected documents keep their cached model.
	 */
	invalidateEnrichmentFor(affectedIds: Set<string>): void {
		if (affectedIds.size === 0) return;
		if (!this._enrichment) return;
		const { indexer } = this._enrichment;
		let count = 0;
		const toEvict: string[] = [];
		for (const [entryKey, entry] of this._cache) {
			let affected = false;
			for (const ref of entry.model.refs) {
				const uids = indexer.findModelsByName(ref.model);
				if (uids.some(m => affectedIds.has(m.uniqueId))) {
					affected = true;
					break;
				}
			}
			if (!affected) {
				for (const src of entry.model.sources) {
					for (const id of affectedIds) {
						if (id.endsWith(`.${src.sourceName}.${src.tableName}`)) {
							affected = true;
							break;
						}
					}
					if (affected) break;
				}
			}
			if (affected) {
				toEvict.push(entryKey);
				count++;
			}
		}
		for (const k of toEvict) {
			this._cache.delete(k);
		}
		if (count > 0) {
			this._logger.debug(`[parse-service] parse cache evicted ${count} document(s) affected by ${affectedIds.size} node(s)`);
		}
	}

	/**
	 * Evict cache entries that were parsed before the manifest loaded.
	 *
	 * Detectable symptom: the model has ref() calls (model.refs.length > 0) but
	 * aliases is an empty dict — enrichment ran but the indexer had no models yet,
	 * so no schema was passed to the bridge. These entries will never be corrected
	 * by OnAliasesReady (same version → cache hit) so they need explicit eviction
	 * when the index becomes available.
	 *
	 * Called by extension.ts on each onIndexRebuild so the next getDocumentModel()
	 * call triggers a fresh enriched parse.
	 */
	evictUnenrichedDocuments(): void {
		if (!this._enrichment) return;
		const toEvict: string[] = [];
		for (const [key, entry] of this._cache) {
			const { model } = entry;
			if (model.refs.length > 0 && model.aliases !== undefined && Object.keys(model.aliases).length === 0) {
				toEvict.push(key);
			}
		}
		for (const k of toEvict) this._cache.delete(k);
		if (toEvict.length > 0) {
			this._logger.debug(`[parse-service] evicted ${toEvict.length} un-enriched cache entry(ies) on index rebuild`);
		}
	}

	/**
	 * Resolve a cursor position against the token map from the AST.
	 * Returns what the cursor is sitting on: a column reference,
	 * a table qualifier (the alias prefix of a column), a table reference
	 * (in FROM/JOIN), or a table alias definition.
	 */
	static resolveAtPosition(
		model: DocumentModel,
		line: number,
		col: number,
	): PositionResolution | null {
		// Table alias definitions take priority over column_ref qualifier spans.
		// When schema-aware qualify() expands SELECT * it synthesises column_ref
		// tokens whose tableCol lands on the alias token's position — without this
		// priority pass those synthetic tokens would shadow the real alias site.
		for (const token of model.tokens) {
			if (
				token.type === 'table_ref'
				&& token.alias !== undefined
				&& token.aliasLine === line
				&& token.aliasCol !== undefined
				&& token.aliasEndCol !== undefined
				&& col >= token.aliasCol
				&& col < token.aliasEndCol
			) {
				return { kind: 'table_alias', token };
			}
		}

		for (const token of model.tokens) {
			if (token.type === 'column_ref') {
				// Check the column name span
				if (token.line === line && col >= token.col && col < token.endCol) {
					return { kind: 'column', token };
				}
				// Check the table qualifier span (e.g. the `o` in `o.order_id`)
				if (
					token.table !== undefined
					&& token.tableLine === line
					&& token.tableCol !== undefined
					&& token.tableEndCol !== undefined
					&& col >= token.tableCol
					&& col < token.tableEndCol
				) {
					return { kind: 'table_qualifier', token };
				}
			} else if (token.type === 'column_def') {
				if (token.line === line && col >= token.col && col < token.endCol) {
					return { kind: 'column_def', token };
				}
			} else {
				// table_ref — check the table name span
				if (token.line === line && col >= token.col && col < token.endCol) {
					return { kind: 'table_ref', token };
				}
			}
		}
		return null;
	}

	/**
	 * Resolve a cursor position against sqllens's native symbols (the Sym wave 2
	 * successor to `resolveAtPosition`). Returns the smallest-span `Sym` covering
	 * the position — a column/table/cte/alias/function symbol, whichever is most
	 * specific — or `undefined` when nothing covers it.
	 *
	 * Unlike `resolveAtPosition`, no alias-priority pass is needed: sqllens's Sym
	 * spans always come from real CST nodes (frozen IR, never synthesized), so a
	 * real alias span and a real column span never legitimately overlap the way
	 * the legacy qualify()'s synthetic star-expansion tokens once could.
	 */
	static symAtPosition(model: DocumentModel, line: number, col: number): Sym | undefined {
		let best: Sym | undefined;
		let bestWidth = Infinity;
		for (const sym of model.symbols ?? []) {
			const width = symSpanContains(sym.span, line, col);
			if (width !== undefined && width < bestWidth) { best = sym; bestWidth = width; }
		}
		return best;
	}

	/**
	 * For a column-reference `Sym` (whose span covers the WHOLE dotted reference,
	 * e.g. all of `o.order_id`), which dotted part the cursor sits on — 0 for the
	 * first part, `parts.length - 1` for the column name itself. `undefined` when
	 * the symbol carries no `partSpans` (a single-part reference, or a synthesized
	 * part sqllens couldn't give its own span) or the cursor isn't on any part.
	 */
	static partIndexAtPosition(sym: Sym, line: number, col: number): number | undefined {
		if (!sym.partSpans) return undefined;
		for (let i = 0; i < sym.partSpans.length; i++) {
			if (symSpanContains(sym.partSpans[i], line, col) !== undefined) return i;
		}
		return undefined;
	}

	private async _parse(
		document: vscode.TextDocument,
		key: string,
		skipEnrichment = false,
	): Promise<DocumentModel | null> {
		const rawText = document.getText();

		// Build qualify schema hint from indexer columns (synchronous, fast path).
		// Then describe all upstream refs so the bridge receives a full schema_mapping
		// and can resolve alias → column mappings in a single round-trip.
		const schema: Record<string, Record<string, string>> = {};
		const schemaMapping: Record<string, Record<string, Record<string, Record<string, object>>>> = {};

		if (this._enrichment && !skipEnrichment) {
			const { indexer, describeCache } = this._enrichment;
			const refs = resolveTagRelations(
				rawText,
				parseTemplated(rawText, toSqllensDialect(indexer.adapterType)).tags,
				indexer,
			);

			const mapping = indexer.buildSchemaMapping();
			await Promise.all([...refs].map(async ([tableName, uniqueId]) => {
				const cols = await describeCache.columns(uniqueId);
				if (cols && cols.length > 0) {
					schema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c.toLowerCase(), 'varchar']));
					const schDb = (mapping['__described__'] ??= {});
					const schSch = (schDb['__described__'] ??= {});
					schSch[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c, {}]));
				}
			}));

			Object.assign(schemaMapping, mapping);
		}

		const options = {
			schema: Object.keys(schema).length > 0 ? schema : undefined,
			schemaMapping: Object.keys(schemaMapping).length > 0 ? schemaMapping : undefined,
		};

		// One realized text per branch arm (sqllens templateVariants: variant 0 is
		// all-defaults plus one variant per non-default arm — linear in arm count,
		// and coverage-complete for mergeModels' byte-range union: every arm's
		// bytes are active in at least one variant). realize() is length-preserving,
		// so all positions in the returned models are in original-source coordinates.
		const variants = templateVariants(rawText, toSqllensDialect(this._enrichment?.indexer.adapterType));
		let model: DocumentModel;

		if (variants.length <= 1) {
			// Fast path: no Jinja conditionals, single parser call.
			model = await this._parser.parse(rawText, options);
		} else {
			// Multi-variant path: parse each branch combination and merge.
			const variantModels: DocumentModel[] = [];
			for (const variant of variants) {
				try {
					variantModels.push(await this._parser.parse(variant.text(), options));
				} catch {
					// silently skip failed variants — individual branch failures are expected
				}
			}
			if (variantModels.length === 0) {
				throw new Error(`all ${variants.length} Jinja variants failed to parse for ${document.fileName}`);
			}
			model = mergeModels(variantModels);
		}

		const hasSyntaxError = model.parseWarnings?.some(w => w.type === 'syntax_error') ?? false;
		if (hasSyntaxError) {
			// Overlay warnings onto last good model so consumers still get useful structural data.
			const prev = this._cache.get(key)?.model;
			if (prev) {
				model = { ...prev, status: 'syntax_error', parseWarnings: model.parseWarnings, timing: model.timing };
			} else {
				model = { ...model, status: 'syntax_error' };
			}
		} else {
			model = { ...model, status: 'ok' };
		}

		const entry: CacheEntry = { version: document.version, model };
		this._cache.set(key, entry);
		this._logger.trace(
			`[parse-service] parsed ${document.fileName} — ${model.ctes.length} CTEs, `
			+ `${model.refs.length} refs, ${Object.keys(model.aliases ?? {}).length} aliases in ${model.timing.totalMs}ms`,
		);

		if (model.parseWarnings && model.parseWarnings.length > 0) {
			this._logger.debug(`[parse-service] ${model.parseWarnings.length} parse warning(s) in ${document.fileName}`);
		}
		this._onParseWarnings.fire({ uri: document.uri, warnings: model.parseWarnings ?? [] });
		this._onAliasesReady.fire(document.uri);

		return model;
	}

	/**
	 * Parse a raw SQL string for workspace-level diagnostics.
	 * No caching, no enrichment, no variant expansion. Single bridge call.
	 * Throws if the parse fails — callers should handle errors.
	 */
	async parseContent(_uri: vscode.Uri, content: string): Promise<DocumentModel> {
		return this._parser.parse(content);
	}

	/**
	 * Parse a raw SQL string (no Jinja) and return its CTEs.
	 * Used by the profiler to extract CTE positions from compiled SQL.
	 * No caching, no enrichment, no variant expansion — single bridge call.
	 */
	async parseSqlString(sql: string): Promise<CteInfo[]> {
		try {
			const model = await this._parser.parse(sql);
			return model.ctes;
		} catch {
			return [];
		}
	}

	/**
	 * Decompose compiled SQL into debug frames (CTEs + _main_) and per-frame clauses.
	 * Returns a JSON string describing the frame structure.
	 * Returns `undefined` when the parser backend does not support decompose.
	 */
	async decomposeQuery(compiledSql: string): Promise<string | undefined> {
		return this._parser.decomposeQuery?.(compiledSql);
	}
}
