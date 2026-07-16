import * as vscode from 'vscode';
import type { DescribeCache } from '../dbt/describe-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { symbolAt } from '../ftl/sqllens/api';
import { makeTemplateProvider } from '../ftl/sqllens/template-shape';
import type { ILogger } from '../types/logger';
import type { DocumentParser, ParseOptions } from './document-parser';
import type { JinjaToken } from '../ftl/sql-tokens';
import type { AstIndex } from '../ninja/reflow/ast-index';
import type { NinjaSqlToken } from '../ftl/ninja-sql-tokens';
import type { Completion, SignatureHelpInfo, Sym, TemplateProvider } from '../ftl/sqllens/api';

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
	/**
	 * sqllens's native symbol model — carries a relation's alias (`Sym.alias`) and a
	 * column reference's bound source (`Sym.source`) directly. Absent only on
	 * synthetic / test fixture models that hand-build a DocumentModel directly; real
	 * parser output always sets it.
	 */
	symbols?: Sym[];
	timing: { parseMs: number; totalMs: number };
	/**
	 * Parse status. 'syntax_error' means the model's structural data (ctes, symbols, etc.) is
	 * carried over from the last good parse — only parseWarnings reflects the current state.
	 */
	status?: 'ok' | 'syntax_error';
	/** Structural warnings from parsing and scope analysis. */
	parseWarnings?: ParseWarning[];
	/**
	 * Upstream relation → column-name map, keyed by the relation's in-scope name
	 * (lowercased): the model name for `{{ ref(...) }}`, the table name for
	 * `{{ source(...) }}`. Produced by the parse itself from the template
	 * provider's positive relation answers (described warehouse columns) — only
	 * relations the provider actually resolved appear; a cold or unknown relation
	 * contributes nothing. Absent only on synthetic / test fixture models.
	 */
	relationColumns?: Record<string, string[]>;
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
	 * When a file has Jinja conditionals, the parser composes the per-arm
	 * indexes so each branch keeps structural coverage at its own bytes.
	 */
	astIndex?: AstIndex;
}

/**
 * Optional dependencies for schema-aware parsing. When provided, ParseService
 * builds the enriched template provider from them per parse — manifest lookups
 * plus the describe-backed relation answers the parser's analysis resolves
 * against.
 */
export interface EnrichmentConfig {
	describeCache: DescribeCache;
	indexer: ManifestIndexer;
}

interface CacheEntry {
	version: number;
	model: DocumentModel;
}

/** A `Sym` kind that `relationSymbol` (sqllens's own symbol emitter) can produce for a
 *  FROM/JOIN source or CTE reference — every kind that can carry an alias via `aliasOf`. */
function isRelationSym(sym: Sym): boolean {
	return (sym.kind === 'table' || sym.kind === 'cte' || sym.kind === 'subquery' || sym.kind === 'lateral')
		&& sym.modifiers.includes('reference');
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
	 * The manifest-backed template provider: macro-shape classification plus
	 * warehouse-backed ref/source relation answers, and the `templateCandidates` catalog
	 * sqllens asks for in a jinja call slot. `undefined` when nothing is configured — the
	 * parser then falls back to the static dbt overlay.
	 *
	 * Built fresh per call by contract (instances are per-parse-cycle: misses accumulate on
	 * the instance and one `prime()` warms them all).
	 */
	private _makeProvider(skipEnrichment = false): TemplateProvider | undefined {
		const enrichment = skipEnrichment ? undefined : this._enrichment;
		return enrichment
			? makeTemplateProvider(name => enrichment.indexer.findMacroByName(name)?.macroSql, enrichment)
			: undefined;
	}

	/**
	 * Editor completion candidates at char `offset` in `sql` — delegates to the parser's
	 * sqllens-backed `completeAt` (its own error-tolerant mid-edit parse, no DocumentModel
	 * cache involved). The manifest provider rides along so a caret in a jinja call slot
	 * gets dbt model / source / macro names back as `kind: "template"`.
	 * `[]` when the parser lacks the capability.
	 */
	completeAt(sql: string, offset: number): Completion[] {
		return this._parser.completeAt?.(sql, offset, this._makeProvider()) ?? [];
	}

	/**
	 * Signature help for the SQL function call enclosing char `offset` in `sql`, or
	 * `null` when the caret is not inside a recognizable call (or unsupported).
	 */
	signatureAt(sql: string, offset: number): SignatureHelpInfo | null {
		return this._parser.signatureAt?.(sql, offset, this._makeProvider()) ?? null;
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
		const alias = ref.kind === 'subquery' ? ref.alias : undefined;
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
	 * Checks CTE projections first (a CTE shadows a same-named table in-file),
	 * then the parse's own upstream relation columns (described ref/source
	 * tables). Returns `undefined` when neither knows the relation (e.g. an
	 * externally-defined CTE passed in by the macro caller, or an undescribed
	 * upstream table — never-wrong, no fabricated list).
	 */
	static columnsForRef(ref: Sym, model: DocumentModel): string[] | undefined {
		const cte = ParseService.cteForRef(ref, model);
		if (cte) return cte.columns.map(c => c.name);
		return model.relationColumns?.[ref.name.toLowerCase()];
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
	 * Compute the combined alias → column-name map from a parsed model: CTE
	 * names/aliases, the parse's upstream relation columns (described ref/source
	 * tables), and any FROM/JOIN alias pointing at either.
	 */
	static resolveAliases(model: DocumentModel): Record<string, string[]> {
		const aliases: Record<string, string[]> = {};
		for (const cte of model.ctes) {
			const cols = cte.columns.map(c => c.name);
			aliases[cte.name] = cols;
			if (cte.alias) aliases[cte.alias] = cols;
		}
		// Upstream relations by their in-scope name. A same-named CTE wins — it
		// shadows the table inside the file, matching SQL scoping.
		for (const [name, cols] of Object.entries(model.relationColumns ?? {})) {
			aliases[name] ??= cols;
		}
		// Resolve FROM/JOIN aliases that point to a CTE or an upstream relation.
		// e.g. `{{ ref('orders') }} as o` — `o` maps to orders' described columns.
		for (const sym of model.symbols ?? []) {
			if (!isRelationSym(sym) || !sym.alias) continue;
			const aliasLc = sym.alias.name.toLowerCase();
			if (aliasLc in aliases) continue;
			const targetCols = aliases[sym.name.toLowerCase()];
			if (targetCols) aliases[aliasLc] = targetCols;
		}
		return aliases;
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
	 * no relation resolved any columns — the provider had no manifest to resolve
	 * unique_ids against (or every describe failed), so the parse stayed cold.
	 * A cached entry never re-parses on its own (same version → cache hit), so
	 * these need explicit eviction when the index becomes available.
	 *
	 * Called by extension.ts on each onIndexRebuild so the next getDocumentModel()
	 * call triggers a fresh enriched parse.
	 */
	evictUnenrichedDocuments(): void {
		if (!this._enrichment) return;
		const toEvict: string[] = [];
		for (const [key, entry] of this._cache) {
			const { model } = entry;
			if (model.refs.length > 0 && Object.keys(model.relationColumns ?? {}).length === 0) {
				toEvict.push(key);
			}
		}
		for (const k of toEvict) this._cache.delete(k);
		if (toEvict.length > 0) {
			this._logger.debug(`[parse-service] evicted ${toEvict.length} un-enriched cache entry(ies) on index rebuild`);
		}
	}

	/**
	 * Resolve a cursor OFFSET (absolute 0-based char index — what
	 * `TextDocument.offsetAt(position)` yields, same UTF-16 units sqllens spans
	 * carry) against sqllens's native symbols, via sqllens's own `symbolAt`:
	 * the narrowest covering `Sym` by true character width, or `undefined`.
	 * A zero-width span (schema-expanded star column) never matches — its
	 * designed contract.
	 *
	 * No alias-priority pass is needed: sqllens's Sym spans always come from real
	 * CST nodes (frozen IR, never synthesized), so a real alias span and a real
	 * column span never legitimately overlap the way the legacy qualify()'s
	 * synthetic star-expansion tokens once could.
	 */
	static symAtPosition(model: DocumentModel, offset: number): Sym | undefined {
		return symbolAt(model.symbols ?? [], offset);
	}

	/**
	 * For a column-reference `Sym` (whose span covers the WHOLE dotted reference,
	 * e.g. all of `o.order_id`), which dotted part the cursor OFFSET sits on — 0
	 * for the first part, `parts.length - 1` for the column name itself.
	 * `undefined` when the symbol carries no `partSpans` (a single-part
	 * reference, or a synthesized part sqllens couldn't give its own span) or
	 * the cursor isn't on any part (e.g. the dot between parts).
	 */
	static partIndexAtPosition(sym: Sym, offset: number): number | undefined {
		if (!sym.partSpans) return undefined;
		for (let i = 0; i < sym.partSpans.length; i++) {
			const p = sym.partSpans[i];
			if (p.start <= offset && offset < p.end) return i;
		}
		return undefined;
	}

	private async _parse(
		document: vscode.TextDocument,
		key: string,
		skipEnrichment = false,
	): Promise<DocumentModel | null> {
		const rawText = document.getText();

		// ONE enriched provider per parse cycle (manifest-shape classification +
		// warehouse-backed ref/source relation answers). Every variant shares it, so
		// describe misses accumulate across variants and one prime() warms them all.
		// The provider doubles as qualify()'s SchemaProvider inside the parser, which
		// is what resolves templated sources to real columns and scopes the
		// unknown-column diagnostics to positively-described relations only.
		const provider = this._makeProvider(skipEnrichment);
		const options: ParseOptions | undefined = provider ? { templateProvider: provider } : undefined;

		// ONE parser call — the variant-aware SqlDocument inside the adapter owns
		// branch-arm fan-out and the cross-arm unions (the variant wave). This
		// layer stopped knowing variants exist.
		let model = await this._parser.parse(rawText, options);
		// Cold-start warm cycle: the parse recorded a describe miss for every
		// resolvable-but-cold ref/source; prime() drains them through the describe
		// cache (async, coalesced) and the single re-parse reads warm. Steady state
		// (warm cache) records no misses and prime() is a no-op.
		if (provider && await provider.prime()) {
			model = await this._parser.parse(rawText, options);
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
			+ `${model.refs.length} refs, ${Object.keys(model.relationColumns ?? {}).length} resolved relations in ${model.timing.totalMs}ms`,
		);

		if (model.parseWarnings && model.parseWarnings.length > 0) {
			this._logger.debug(`[parse-service] ${model.parseWarnings.length} parse warning(s) in ${document.fileName}`);
		}
		this._onParseWarnings.fire({ uri: document.uri, warnings: model.parseWarnings ?? [] });

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
