import * as vscode from 'vscode';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { DescribeCache } from '../dbt/describe-cache';
import type { DbtExecutionService } from '../dbt/execution-service';
import type { ScopeColumnsCache } from '../dbt/scope-columns-cache';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
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
	/** 0-based line of the closing paren of the CTE body */
	endLine: number;
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

export interface DocumentModel {
	ctes: CteInfo[];
	refs: RefInfo[];
	sources: SourceInfo[];
	finalColumns: ColumnInfo[];
	tokens: TokenInfo[];
	timing: { parseMs: number; totalMs: number };
	/**
	 * Alias → column-name map populated asynchronously after the initial parse.
	 * `undefined` while enrichment is pending or not configured.
	 */
	aliases?: Record<string, string[]>;
}

/**
 * Optional enrichment dependencies that enable Tier-2 alias resolution.
 * When provided, ParseService will asynchronously describe upstream tables
 * and resolve alias → column mappings after the fast structural parse.
 */
export interface EnrichmentConfig {
	service: DbtExecutionService;
	describeCache: DescribeCache;
	indexer: ManifestIndexer;
	scopeColumnsCache: ScopeColumnsCache;
}

interface CacheEntry {
	version: number;
	model: DocumentModel;
	/** Dialect used for this parse — needed for re-use during enrichment. */
	dialect: string;
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
	private readonly _enrichInflight = new Map<string, Promise<void>>();

	private readonly _onEnrichmentComplete = new vscode.EventEmitter<vscode.Uri>();
	readonly onEnrichmentComplete = this._onEnrichmentComplete.event;

	constructor(
		private readonly _bridge: BridgeRunner,
		private readonly _logger: ILogger,
		private readonly _enrichment?: EnrichmentConfig,
	) {}

	/**
	 * Return the DocumentModel for the given document.
	 * Re-parses via the bridge only when the version has changed.
	 *
	 * Returns immediately with `model.aliases === undefined` while Tier-2
	 * enrichment runs in the background. Callers that need aliases should use
	 * `getAliases()` to await the enriched result.
	 */
	async getDocumentModel(
		document: vscode.TextDocument,
		dialect: string,
	): Promise<DocumentModel | null> {
		const key = document.uri.toString();
		const cached = this._cache.get(key);
		if (cached && cached.version === document.version) {
			this._triggerEnrichment(document, key, cached);
			return cached.model;
		}

		// Deduplicate concurrent requests for the same version.
		const inflightKey = `${key}@${document.version}`;
		const existing = this._inflight.get(inflightKey);
		if (existing) {
			return existing;
		}

		const promise = this._parse(document, key, dialect);
		this._inflight.set(inflightKey, promise);
		try {
			return await promise;
		} finally {
			this._inflight.delete(inflightKey);
		}
	}

	/**
	 * Return the alias → column-name map for the given document.
	 * Awaits Tier-2 enrichment if it is in progress; triggers it if not yet started.
	 * Returns `{}` when enrichment is not configured or yields no results.
	 */
	async getAliases(
		document: vscode.TextDocument,
		dialect: string,
		token: vscode.CancellationToken,
	): Promise<Record<string, string[]>> {
		const model = await this.getDocumentModel(document, dialect);
		if (!model) return {};
		// Always include CTE columns (by CTE name and alias) so alias.column works
		// without waiting for async enrichment.
		const cteAliases: Record<string, string[]> = {};
		for (const cte of model.ctes) {
			const cols = cte.columns.map(c => c.name);
			cteAliases[cte.name] = cols;
			if (cte.alias) cteAliases[cte.alias] = cols;
		}
		// Also resolve FROM/JOIN aliases that point to CTEs.
		// e.g. `LEFT JOIN address_with_country AS addr` where address_with_country
		// is a CTE — `addr` must map to that CTE's columns.
		for (const token of model.tokens) {
			if (token.type === 'table_ref' && token.alias) {
				const aliasLc = token.alias.toLowerCase();
				if (aliasLc in cteAliases) continue;
				const targetCols = cteAliases[token.name.toLowerCase()];
				if (targetCols) cteAliases[aliasLc] = targetCols;
			}
		}
		if (model.aliases !== undefined) return { ...cteAliases, ...model.aliases };
		if (!this._enrichment) return cteAliases;
		if (token.isCancellationRequested) return cteAliases;

		const key = document.uri.toString();
		const enrichKey = `${key}@${document.version}`;

		// If background enrichment was already triggered, await it.
		const inflight = this._enrichInflight.get(enrichKey);
		if (inflight) {
			await inflight;
			return model.aliases ?? {};
		}

		// Trigger enrichment ourselves (with cancellation support).
		const cached = this._cache.get(key);
		if (!cached) return {};

		const promise = this._enrich(document, key, cached, token);
		this._enrichInflight.set(enrichKey, promise);
		try {
			await promise;
		} finally {
			this._enrichInflight.delete(enrichKey);
		}
		return { ...cteAliases, ...(model.aliases ?? {}) };
	}

	/**
	 * Return cached aliases synchronously without triggering resolution.
	 * Returns `null` when the model is not parsed yet or aliases are still pending.
	 */
	getCachedAliases(document: vscode.TextDocument): Record<string, string[]> | null {
		const cached = this._cache.get(document.uri.toString());
		if (cached && cached.version === document.version) {
			return cached.model.aliases ?? null;
		}
		return null;
	}

	/**
	 * Clear enriched alias caches for all documents.
	 * Call after manifest reload — table schemas may have changed but
	 * structural positions (CTEs, refs) remain valid.
	 */
	invalidateEnrichment(): void {
		for (const entry of this._cache.values()) {
			entry.model.aliases = undefined;
		}
		this._enrichment?.scopeColumnsCache.clear();
		this._logger.debug('[parse-service] enrichment cache invalidated');
	}

	/**
	 * Clear enriched aliases only for documents that reference any of the given
	 * unique IDs. Documents that don't reference any of the affected nodes keep
	 * their cached aliases intact.
	 */
	invalidateEnrichmentFor(affectedIds: Set<string>): void {
		if (affectedIds.size === 0) return;
		if (!this._enrichment) return;
		const { indexer } = this._enrichment;
		let count = 0;
		for (const [uri, entry] of this._cache) {
			if (entry.model.aliases === undefined) continue;
			// Check if any ref in this document's model points to an affected node
			const text = entry.model.refs;
			let affected = false;
			for (const ref of text) {
				const uids = indexer.findModelsByName(ref.model);
				if (uids.some(m => affectedIds.has(m.uniqueId))) {
					affected = true;
					break;
				}
			}
			if (!affected) {
				for (const src of entry.model.sources) {
					const key = `source.${src.sourceName}.${src.tableName}`;
					// Source unique IDs follow the pattern source.<project>.<source_name>.<table_name>
					// Check if any affected ID matches this source
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
				entry.model.aliases = undefined;
				count++;
			}
		}
		if (count > 0) {
			// Also clear scope_columns cache since schema mapping may have changed
			this._enrichment.scopeColumnsCache.clear();
			this._logger.debug(`[parse-service] enrichment invalidated for ${count} document(s) affected by ${affectedIds.size} node(s)`);
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
	): Promise<DocumentModel | null> {
		const rawText = document.getText();

		// Build a schema hint from any already-cached describe results so that
		// sqlglot qualify() can resolve bare (unqualified) column references in
		// the very first parse when the describe cache is warm.  This is purely
		// opportunistic — if the cache is cold the dict stays empty and behaviour
		// is identical to before.
		const schema: Record<string, Record<string, string>> = {};
		if (this._enrichment) {
			const { refs } = stripJinja(rawText, this._enrichment.indexer);
			for (const [tableName, uniqueId] of refs) {
				const cols = this._enrichment.indexer.getColumns(uniqueId);
				if (cols && cols.length > 0) {
					schema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c.toLowerCase(), 'varchar']));
				}
			}
		}

		const parseRequest: Record<string, unknown> = {
			parse_document: true,
			sql: rawText,
			dialect: dialect || 'ansi',
		};
		if (Object.keys(schema).length > 0) {
			parseRequest['schema'] = schema;
		}

		const result = await this._bridge.invokeRaw(parseRequest);

		if (!result.success || !result.data) {
			const errMsg = (result.data as Record<string, unknown>)?.['error'] ?? 'no response';
			this._logger.debug(`[parse-service] parse_document failed for ${document.fileName}: ${String(errMsg)}`);
			return null;
		}

		const data = result.data as unknown as (DocumentModel & { success: boolean });
		const model: DocumentModel = {
			ctes: data.ctes ?? [],
			refs: data.refs ?? [],
			sources: data.sources ?? [],
			finalColumns: data.finalColumns ?? [],
			tokens: (data as unknown as Record<string, unknown>).tokens as TokenInfo[] ?? [],
			timing: data.timing ?? { parseMs: 0, totalMs: 0 },
		};

		const entry: CacheEntry = { version: document.version, model, dialect: dialect || 'ansi' };
		this._cache.set(key, entry);
		this._logger.debug(
			`[parse-service] parsed ${document.fileName} — ${model.ctes.length} CTEs, `
			+ `${model.refs.length} refs in ${model.timing.totalMs}ms (sqlglot: ${model.timing.parseMs}ms)`,
		);

		// Kick off background enrichment immediately after parsing.
		this._triggerEnrichment(document, key, entry);

		return model;
	}

	/** Fire-and-forget background enrichment. No-op if already running or done. */
	private _triggerEnrichment(
		document: vscode.TextDocument,
		key: string,
		entry: CacheEntry,
	): void {
		if (entry.model.aliases !== undefined) return;
		if (!this._enrichment) return;

		const enrichKey = `${key}@${entry.version}`;
		if (this._enrichInflight.has(enrichKey)) return;

		const promise = this._enrich(document, key, entry);
		this._enrichInflight.set(enrichKey, promise);
		void promise.finally(() => {
			this._enrichInflight.delete(enrichKey);
		});
	}

	private async _enrich(
		document: vscode.TextDocument,
		_key: string,
		entry: CacheEntry,
		token?: vscode.CancellationToken,
	): Promise<void> {
		if (!this._enrichment) return;
		const { describeCache, indexer, scopeColumnsCache } = this._enrichment;

		try {
			const { sql, refs } = stripJinja(document.getText(), indexer);
			if (!sql.trim()) {
				entry.model.aliases = {};
				return;
			}

			const schemaMapping = indexer.buildSchemaMapping();
			const dialect = entry.dialect;

			// Phase 3: Fire all describe requests concurrently.
			// DescribeCache already has inflight dedup — concurrent calls for the
			// same uniqueId share one Promise. Cache hits return immediately.
			const describePromises = [...refs].map(async ([tableName, uniqueId]) => {
				if (token?.isCancellationRequested) return;

				const node = indexer.getRawNode(uniqueId);
				const isSource = uniqueId.startsWith('source.');
				const modelName = node && 'name' in node ? String(node.name) : tableName;
				const sourceName = isSource && node && 'source_name' in node ? String(node.source_name) : undefined;

				const cols = await describeCache.describeTable(uniqueId, modelName, sourceName);
				if (cols && cols.length > 0) {
					const db = (schemaMapping['__described__'] ??= {});
					const schema = (db['__described__'] ??= {});
					schema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c, {}]));
				}
			});
			await Promise.all(describePromises);

			if (token?.isCancellationRequested) return;

			// Phase 2: Use ScopeColumnsCache — returns cached result when SQL
			// and schema mapping haven't changed, avoiding a queue round-trip.
			const aliases = await scopeColumnsCache.scopeColumns(sql, dialect, schemaMapping);

			// Update the model in-place — all existing references see the enriched result.
			entry.model.aliases = aliases;

			this._logger.debug(
				`[parse-service] enriched ${document.fileName} — `
				+ `${Object.keys(entry.model.aliases).length} aliases`,
			);

			// Notify listeners (e.g. diagnostics provider) so they can re-validate.
			this._onEnrichmentComplete.fire(document.uri);
		} catch (err) {
			this._logger.debug(`[parse-service] enrichment failed for ${document.fileName}: ${err}`);
			// Leave aliases as undefined — next call will retry enrichment.
		}
	}

	/** Remove cached entry when a document is closed. */
	evict(uri: vscode.Uri): void {
		this._cache.delete(uri.toString());
	}
}
