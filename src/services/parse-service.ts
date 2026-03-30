import * as vscode from 'vscode';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { DescribeCache } from '../dbt/describe-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { generateVariants } from '../dbt/sql-variant-generator';
import { stripJinja } from '../providers/jinja-utils';
import type { ILogger } from '../types/logger';

export interface ColumnInfo {
	name: string;
	/** 0-based line of the column expression in the document */
	line: number;
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
 * A structural issue detected by sqlglot during parsing — e.g. a CTE whose
 * body cannot be scope-analysed because it uses an unsupported construct
 * (typically an `Aliases` node produced by a dangling identifier before the CTE).
 * dbt itself won't detect this because `dbt parse` does not compile the SQL.
 */
export interface SqlglotWarning {
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

export interface DocumentModel {
	ctes: CteInfo[];
	refs: RefInfo[];
	sources: SourceInfo[];
	finalColumns: ColumnInfo[];
	tokens: TokenInfo[];
	timing: { parseMs: number; totalMs: number };
	/** Structural warnings emitted by sqlglot during scope building. */
	sqlglotWarnings?: SqlglotWarning[];
	/**
	 * Alias → column-name map returned by the bridge after schema-aware parsing.
	 * `undefined` only when enrichment is not configured; otherwise always a dict
	 * (empty when schema_mapping had no entries for the upstream tables).
	 */
	aliases?: Record<string, string[]>;
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
	/** Dialect used for this parse. */
	dialect: string;
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

	return { ctes: [...cteMap.values()], refs, sources, finalColumns, tokens, timing, sqlglotWarnings, aliases };
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
		private readonly _bridge: BridgeRunner,
		private readonly _logger: ILogger,
		private readonly _enrichment?: EnrichmentConfig,
	) {}

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
		dialect: string,
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

		const promise = this._parse(document, key, dialect, skipEnrichment);
		this._inflight.set(inflightKey, promise);
		try {
			return await promise;
		} finally {
			this._inflight.delete(inflightKey);
		}
	}

	/**
	 * Return the column list for the table that `ref` points to.
	 * Checks CTE projections first, then manifest-enriched aliases.
	 * Returns `undefined` when the table is not locally defined (e.g. an
	 * externally-defined CTE passed in by the macro caller).
	 */
	static columnsForRef(ref: TableRefToken, model: DocumentModel): string[] | undefined {
		const nameLc = ref.name.toLowerCase();
		const cte = model.ctes.find(c => c.name.toLowerCase() === nameLc);
		if (cte) return cte.columns.map(c => c.name);
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
			if (ref.alias && ref.alias.toLowerCase() !== ref.name.toLowerCase()) {
				return [ref.alias, refStr];
			}
			return [refStr];
		}

		return chain;
	}

	/**
	 * Compute the combined alias → column-name map from a parsed model.
	 * Merges bridge-resolved upstream aliases (model.aliases) with CTE aliases
	 * and any FROM/JOIN aliases that point to CTEs.
	 */
	/**
	 * Resolve what a SQL alias refers to in a DocumentModel.
	 *
	 * When `atLine` is provided the lookup is scoped to the enclosing CTE body
	 * first, so inner aliases shadow outer ones correctly.
	 */
	static resolveAlias(
		model: DocumentModel,
		alias: string,
		atLine: number,
	): { kind: 'cte'; cte: CteInfo } | { kind: 'ref'; ref: RefInfo } | { kind: 'source'; source: SourceInfo } | undefined {
		const lc = alias.toLowerCase();

		const enclosingCte = model.ctes.find(c => atLine > c.line && atLine <= c.endLine);
		if (enclosingCte) {
			const scopedRef = model.refs.find(
				r => r.line >= enclosingCte.line && r.line <= enclosingCte.endLine
					&& (r.alias ?? r.model).toLowerCase() === lc,
			);
			if (scopedRef) return { kind: 'ref', ref: scopedRef };

			const scopedSrc = model.sources.find(
				s => s.line >= enclosingCte.line && s.line <= enclosingCte.endLine
					&& (s.alias ?? s.tableName).toLowerCase() === lc,
			);
			if (scopedSrc) return { kind: 'source', source: scopedSrc };

			const scopedCteTok = model.tokens.find(
				t => t.type === 'table_ref' && t.line >= enclosingCte.line && t.line <= enclosingCte.endLine
					&& t.alias?.toLowerCase() === lc
					&& model.ctes.some(c => c.name.toLowerCase() === t.name.toLowerCase()),
			);
			if (scopedCteTok) {
				const cte = model.ctes.find(c => c.name.toLowerCase() === scopedCteTok.name.toLowerCase())!;
				return { kind: 'cte', cte };
			}
		}

		const directCte = model.ctes.find(c =>
			c.name.toLowerCase() === lc || c.alias?.toLowerCase() === lc,
		);
		if (directCte) return { kind: 'cte', cte: directCte };

		const cteTok = model.tokens.find(t =>
			t.type === 'table_ref' && t.alias?.toLowerCase() === lc
			&& model.ctes.some(c => c.name.toLowerCase() === t.name.toLowerCase()),
		);
		if (cteTok) {
			const cte = model.ctes.find(c => c.name.toLowerCase() === cteTok.name.toLowerCase())!;
			return { kind: 'cte', cte };
		}

		const ref = model.refs.find(r => (r.alias ?? r.model).toLowerCase() === lc);
		if (ref) return { kind: 'ref', ref };

		const src = model.sources.find(s => (s.alias ?? s.tableName).toLowerCase() === lc);
		if (src) return { kind: 'source', source: src };

		return undefined;
	}

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
		dialect: string,
		skipEnrichment = false,
	): Promise<DocumentModel | null> {
		const rawText = document.getText();

		// Build qualify schema hint from indexer columns (synchronous, fast path).
		// Then describe all upstream refs so the bridge receives a full schema_mapping
		// and can resolve alias → column mappings in a single round-trip.
		const qualifySchema: Record<string, Record<string, string>> = {};
		const parseRequest: Record<string, unknown> = {
			parse_document: true,
			sql: rawText,
			dialect: dialect || 'ansi',
		};

		if (this._enrichment && !skipEnrichment) {
			const { indexer, describeCache } = this._enrichment;
			const { refs } = stripJinja(rawText, indexer);

			const schemaMapping = indexer.buildSchemaMapping();
			await Promise.all([...refs].map(async ([tableName, uniqueId]) => {
				const cols = await describeCache.columns(uniqueId);
				if (cols && cols.length > 0) {
					qualifySchema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c.toLowerCase(), 'varchar']));
					const schDb = (schemaMapping['__described__'] ??= {});
					const schSch = (schDb['__described__'] ??= {});
					schSch[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c, {}]));
				}
			}));

			if (Object.keys(schemaMapping).length > 0) {
				parseRequest['schema_mapping'] = schemaMapping;
			}
		}

		if (Object.keys(qualifySchema).length > 0) {
			parseRequest['schema'] = qualifySchema;
		}

		function buildModel(raw: unknown): DocumentModel {
			const d = raw as unknown as (DocumentModel & { success: boolean; sqlglotWarnings?: SqlglotWarning[]; aliases?: Record<string, string[]> });
			return {
				ctes: d.ctes ?? [],
				refs: d.refs ?? [],
				sources: d.sources ?? [],
				finalColumns: d.finalColumns ?? [],
				tokens: (d as unknown as Record<string, unknown>).tokens as TokenInfo[] ?? [],
				timing: d.timing ?? { parseMs: 0, totalMs: 0 },
				sqlglotWarnings: d.sqlglotWarnings ?? [],
				aliases: d.aliases ?? {},
			};
		}

		// Generate one SQL string per branch-combination so every conditional code
		// path gets parsed. generateVariants is length-preserving — all positions
		// in the returned models are in original-source coordinates.
		const variants = generateVariants(rawText);
		let model: DocumentModel;

		if (variants.length <= 1) {
			// Fast path: no Jinja conditionals, single bridge call.
			const result = await this._bridge.invokeRaw(parseRequest);
			if (!result.success || !result.data) {
				const errMsg = (result.data as Record<string, unknown>)?.['error'] ?? 'no response';
				this._logger.debug('[parse-service] parse_document failed for ' + document.fileName + ': ' + String(errMsg));
				return null;
			}
			model = buildModel(result.data);
		} else {
			// Multi-variant path: parse each branch combination and merge.
			const variantModels: DocumentModel[] = [];
			for (const variant of variants) {
				const variantRequest = { ...parseRequest, sql: variant.sql };
				const result = await this._bridge.invokeRaw(variantRequest);
				if (result.success && result.data) {
					variantModels.push(buildModel(result.data));
				}
			}
			if (variantModels.length === 0) {
				this._logger.debug('[parse-service] all ' + variants.length + ' variants failed for ' + document.fileName);
				return null;
			}
			model = mergeModels(variantModels);
		}

		const entry: CacheEntry = { version: document.version, model, dialect: dialect || 'ansi' };
		this._cache.set(key, entry);
		this._logger.debug(
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
	 * Parse a raw SQL string (no Jinja) and return its CTEs.
	 * Used by the profiler to extract CTE positions from compiled SQL.
	 * No caching, no enrichment, no variant expansion — single bridge call.
	 */
	async parseSqlString(sql: string, dialect: string): Promise<CteInfo[]> {
		const result = await this._bridge.invokeRaw({
			parse_document: true,
			sql,
			dialect: dialect || 'ansi',
		});
		if (!result.success || !result.data) return [];
		const d = result.data as { ctes?: CteInfo[] };
		return d.ctes ?? [];
	}
}
