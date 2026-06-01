import * as vscode from 'vscode';
import type { DescribeCache } from '../dbt/describe-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { generateVariants } from '../dbt/sql-variant-generator';
import { stripJinja } from '../providers/common/jinja-utils';
import type { ILogger } from '../types/logger';
import type { DocumentParser } from './document-parser';
import type { AstPayload, JinjaToken, SqlToken } from '../ftl/parse-result';
import { sqlOnly, type NinjaSqlToken } from '../ftl/ninja-sql-tokens';

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
	 * AST index of the nearest enclosing Subquery or CTE node.
	 * undefined means the token is at the top-level (outside all scopes).
	 * Set during extractTokens; used by resolveTableRefs for scope matching.
	 */
	scopeId?: number;
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
	 * AST index of the nearest enclosing Subquery or CTE node.
	 * undefined means the token is at the top-level (outside all scopes).
	 * Set during extractTokens; used by resolveTableRefs for scope matching.
	 */
	scopeId?: number;
	/**
	 * True when the alias was synthesised by qualify() rather than written by the
	 * user. Synthesised aliases have no source position (aliasLine is absent).
	 * Rules should check this flag instead of inspecting aliasLine directly.
	 */
	synthesized?: true;
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
 * A structural issue detected by sqlglot during parsing.
 *
 * - `scope_warning`: SQL parsed OK but sqlglot cannot analyse a CTE scope
 *   (e.g. a bare identifier before the CTE body). `cteName` is set.
 * - `syntax_error`: outright parse failure (typo, missing keyword, etc.).
 *   `cteName` is absent; `line`/`col`/`endCol` point at the bad token.
 */
export interface SqlglotWarning {
	/** Discriminates between structural scope issues and outright syntax errors */
	type: 'scope_warning' | 'syntax_error';
	/** Full sqlglot warning message */
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
	timing: { parseMs: number; totalMs: number };
	/**
	 * Parse status. 'syntax_error' means the model's structural data (ctes, tokens, etc.) is
	 * carried over from the last good parse — only sqlglotWarnings reflects the current state.
	 */
	status?: 'ok' | 'syntax_error';
	/** Structural warnings emitted by sqlglot during scope building. */
	sqlglotWarnings?: SqlglotWarning[];
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
	 * Flat AST payload from sqlglot's `serde.dump()`. Each entry carries its
	 * byte range (`m.start` / `m.end`), class name (`c`), and parent linkage
	 * (`i`, `k`, `a`). The reflow printer consults this to make clause-aware
	 * layout decisions (comma-position, indented_on, CTE body break) instead
	 * of inferring structure from token-stream heuristics.
	 *
	 * When a file has Jinja conditionals, the node set is the byte-range
	 * union of every variant's AST — so each branch has structural coverage
	 * at its own bytes. See `mergeModels` for the merge policy.
	 */
	ast?: AstPayload[];
	/**
	 * Virtual columns synthesised by PIVOT/UNPIVOT clauses, keyed by the
	 * lowercased source-table name. Used to suppress false "column not found"
	 * errors for virtual columns that don't exist in the source CTE's schema.
	 */
	pivotVirtualColumns?: Record<string, string[]>;
	/**
	 * True when this model was produced by the nunjucks-render pass (pass 2).
	 * AST column numbers are in rendered-space and are not remapped — rules
	 * that build vscode.Range from `col.col`/`col.endCol` must skip this model.
	 */
	isPass2?: boolean;
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
 * Merge N DocumentModels produced by separate bridge parse calls (one per SQL
 * variant) into a single model. All positions in each model are expressed in
 * original-source coordinates (generateVariants is length-preserving), so
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

	// sqlglotWarnings: dedup by message
	const warnMessages = new Set<string>();
	const sqlglotWarnings: SqlglotWarning[] = [];
	for (const m of models) {
		for (const w of (m.sqlglotWarnings ?? [])) {
			if (!warnMessages.has(w.message)) { warnMessages.add(w.message); sqlglotWarnings.push(w); }
		}
	}

	const timing = {
		parseMs: models.reduce((s, m) => s + m.timing.parseMs, 0),
		totalMs: models.reduce((s, m) => s + m.timing.totalMs, 0),
	};

	// finalSelect: take the first model that has one (variants produce the same select)
	const finalSelect = models.find(m => m.finalSelect)?.finalSelect;

	// pivotVirtualColumns: union per source table
	const pivotVirtualColumns: Record<string, string[]> = {};
	for (const m of models) {
		for (const [table, cols] of Object.entries(m.pivotVirtualColumns ?? {})) {
			if (!(table in pivotVirtualColumns)) {
				pivotVirtualColumns[table] = [...cols];
			} else {
				const seen = new Set(pivotVirtualColumns[table]);
				for (const c of cols) { if (!seen.has(c)) { pivotVirtualColumns[table].push(c); seen.add(c); } }
			}
		}
	}

	// jinjaTokens / ninjaSqlTokens: all variants are parsed from the same raw source
	// (generateVariants is length-preserving), so every variant's token streams carry
	// the same positions. Take the first model that has them. Dropping them here
	// causes comment-span masking in layout rules to silently stop working for any
	// file that contains Jinja conditionals.
	const jinjaTokens = models.find(m => m.jinjaTokens)?.jinjaTokens;
	const ninjaSqlTokens = models.find(m => m.ninjaSqlTokens)?.ninjaSqlTokens;

	// ast: union by byte range. Each variant's AST covers the shared bytes
	// (outside any Jinja conditional) PLUS its own active branches. Non-active
	// branches in that variant are blanked to spaces, so they contribute no
	// nodes. Unioning across variants gives structural coverage for every
	// branch — nodes from different variants never overlap *inside*
	// conditionals because their spans are disjoint there. Shared nodes
	// (outside conditionals) appear at identical byte ranges in every
	// variant and dedupe via the byte-range key.
	//
	// The combined tree is not logically consistent as a single executable
	// statement (e.g. a Select may end up with two sibling Where nodes, one
	// per branch). That's fine: consumers query by byte range for
	// "what's the structural role here?", not tree traversal.
	const astOut: AstPayload[] = [];
	const covered = new Set<string>();
	for (const m of models) {
		if (!m.ast) continue;
		for (const node of m.ast) {
			const key = `${node.m?.start ?? ''}:${node.m?.end ?? ''}:${node.c ?? ''}`;
			if (covered.has(key)) continue;
			covered.add(key);
			astOut.push(node);
		}
	}

	return { ctes: [...cteMap.values()], refs, sources, macroCalls, finalColumns, finalSelect, tokens, timing, sqlglotWarnings, aliases,
		pivotVirtualColumns: Object.keys(pivotVirtualColumns).length > 0 ? pivotVirtualColumns : undefined,
		jinjaTokens,
		ninjaSqlTokens,
		ast: astOut.length > 0 ? astOut : undefined,
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

	private readonly _onSqlglotWarnings = new vscode.EventEmitter<{ uri: vscode.Uri; warnings: SqlglotWarning[] }>();
	/** Fired after each parse when sqlglot reported structural warnings (e.g. Aliases node type). */
	readonly onSqlglotWarnings = this._onSqlglotWarnings.event;

	constructor(
		private readonly _parser: DocumentParser,
		private readonly _logger: ILogger,
		private readonly _enrichment?: EnrichmentConfig,
	) {}

	/** Cache for dialect symbol fetch — stored as a Promise for dedup on concurrent calls. */
	private _symbolsPromise: Promise<import('../ftl/sql-parser').DialectSymbols | undefined> | undefined;

	/**
	 * Return the authoritative symbol lists (functions, keyword token types, data types)
	 * for the active dialect. Fetched once and cached for the lifetime of this service.
	 * Returns undefined when the parser does not support symbol extraction.
	 */
	getDialectSymbols(): Promise<import('../ftl/sql-parser').DialectSymbols | undefined> {
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
	 * Find the CteInfo that a table_ref token refers to.
	 * When multiple CTEs share the same name (e.g. nested subqueries that
	 * reuse the same alias), the token's line position disambiguates:
	 * pick the CteInfo whose body range [line, endLine] contains the token.
	 */
	static cteForRef(ref: TableRefToken, model: DocumentModel): CteInfo | undefined {
		const nameLc = ref.name.toLowerCase();
		const candidates = model.ctes.filter(c =>
			c.name.toLowerCase() === nameLc || c.alias?.toLowerCase() === nameLc,
		);
		if (candidates.length <= 1) return candidates[0];
		return candidates.find(c => ref.line >= c.line && ref.line <= c.endLine)
			?? candidates[candidates.length - 1];
	}

	/**
	 * Return the column list for the table that `ref` points to.
	 * Checks CTE projections first, then manifest-enriched aliases.
	 * Returns `undefined` when the table is not locally defined (e.g. an
	 * externally-defined CTE passed in by the macro caller).
	 */
	static columnsForRef(ref: TableRefToken, model: DocumentModel): string[] | undefined {
		const nameLc = ref.name.toLowerCase();
		const cte = ParseService.cteForRef(ref, model);
		if (cte) {
			const base = cte.columns.map(c => c.name);
			const extras = model.pivotVirtualColumns?.[nameLc];
			return extras ? [...base, ...extras] : base;
		}
		return model.aliases?.[ref.name] ?? model.aliases?.[nameLc];
	}

	/**
	 * Trace intra-model CTE lineage for a given table_ref.
	 *
	 * Starting from `ref`, if it resolves to a CTE, follow the chain of
	 * table_ref tokens inside each CTE body to build an ordered list of names.
	 * Stops when a node is not a CTE (external ref, source, or plain table).
	 *
	 * Returns an empty array when `ref` is not a CTE.
	 *
	 * Example result: ['address_with_country', "ref('gold__address')"]
	 */
	static traceCteLineage(ref: TableRefToken, model: DocumentModel): string[] {
		const cteByName = new Map(model.ctes.map(c => [c.name.toLowerCase(), c]));
		const chain: string[] = [];
		const visited = new Set<string>();

		let current: TableRefToken | undefined = ref;
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

			// Find the first table_ref token inside this CTE's body range
			const next = (model.tokens as TableRefToken[]).find(
				t => t.type === 'table_ref'
					&& t.line >= cte.line
					&& t.line <= cte.endLine,
			);
			if (!next) break;
			current = next;
		}

		// If the chain only resolved to the start CTE and nothing else was found,
		// check if there's an external table (ref/source) to append
		if (chain.length === 1) {
			const cte = cteByName.get(ref.name.toLowerCase())!;
			// Find any table_ref in its body not already in chain
			const inner = (model.tokens as TableRefToken[]).find(
				t => t.type === 'table_ref'
					&& t.line >= cte.line
					&& t.line <= cte.endLine
					&& !cteByName.has(t.name.toLowerCase()),
			);
			if (inner) {
				// Check if it's a ref()
				const refInfo = model.refs.find(r => r.line === inner.line);
				chain.push(refInfo ? `ref('${inner.name}')` : inner.name);
			}
		} else if (chain.length > 1) {
			// For deeper chains: annotate the last entry if it's a ref()
			const last = chain[chain.length - 1];
			const isRef = model.refs.some(r => {
				const tok = (model.tokens as TableRefToken[]).find(
					t => t.type === 'table_ref' && t.name === last && r.line === t.line,
				);
				return !!tok;
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
			const { refs } = stripJinja(rawText, indexer);

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

		// Generate one SQL string per branch-combination so every conditional code
		// path gets parsed. generateVariants is length-preserving — all positions
		// in the returned models are in original-source coordinates.
		const variants = generateVariants(rawText);
		let model: DocumentModel;

		if (variants.length <= 1) {
			// Fast path: no Jinja conditionals, single parser call.
			model = await this._parser.parse(rawText, options);
		} else {
			// Multi-variant path: parse each branch combination and merge.
			const variantModels: DocumentModel[] = [];
			for (const variant of variants) {
				try {
					variantModels.push(await this._parser.parse(variant.sql, options));
				} catch {
					// silently skip failed variants — individual branch failures are expected
				}
			}
			if (variantModels.length === 0) {
				throw new Error(`all ${variants.length} Jinja variants failed to parse for ${document.fileName}`);
			}
			model = mergeModels(variantModels);
		}

		const hasSyntaxError = model.sqlglotWarnings?.some(w => w.type === 'syntax_error') ?? false;
		if (hasSyntaxError) {
			// Overlay warnings onto last good model so consumers still get useful structural data.
			const prev = this._cache.get(key)?.model;
			if (prev) {
				model = { ...prev, status: 'syntax_error', sqlglotWarnings: model.sqlglotWarnings, timing: model.timing };
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

		if (model.sqlglotWarnings && model.sqlglotWarnings.length > 0) {
			this._logger.debug(`[parse-service] ${model.sqlglotWarnings.length} sqlglot warning(s) in ${document.fileName}`);
		}
		this._onSqlglotWarnings.fire({ uri: document.uri, warnings: model.sqlglotWarnings ?? [] });
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
	 * Parse a raw SQL string and return its sqlglot tokens and jinja token stream.
	 * Returns `undefined` when the parser backend does not supply tokens.
	 * No caching, no enrichment, no variant expansion.
	 */
	async parseRawForTokens(sql: string): Promise<{ sqlTokens: SqlToken[]; jinjaTokens: JinjaToken[] } | undefined> {
		try {
			const model = await this._parser.parse(sql);
			if (!model.ninjaSqlTokens) return undefined;
			return { sqlTokens: sqlOnly(model.ninjaSqlTokens), jinjaTokens: model.jinjaTokens ?? [] };
		} catch {
			return undefined;
		}
	}

	/**
	 * Decompose compiled SQL into debug frames (CTEs + _main_) and per-frame clauses.
	 * Returns raw JSON string from the Pyodide backend.
	 * Returns `undefined` when the parser backend does not support decompose.
	 */
	async decomposeQuery(compiledSql: string): Promise<string | undefined> {
		return this._parser.decomposeQuery?.(compiledSql);
	}
}
