import * as vscode from 'vscode';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { DescribeCache } from '../dbt/describe-cache';
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
	 * Alias → column-name map populated during the parse alongside structural info.
	 * `undefined` only when enrichment is not configured; otherwise always a dict
	 * (empty when schema_mapping had no entries for the upstream tables).
	 */
	aliases?: Record<string, string[]>;
}

/**
 * Optional enrichment dependencies that enable Tier-2 alias resolution.
 * When provided, ParseService will describe upstream tables concurrently
 * and resolve alias → column mappings as part of each parse.
 */
export interface EnrichmentConfig {
	describeCache: DescribeCache;
	indexer: ManifestIndexer;
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
		_token: vscode.CancellationToken,
	): Promise<Record<string, string[]>> {
		const model = await this.getDocumentModel(document, dialect);
		if (!model) return {};
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
		this._cache.clear();
		this._logger.debug('[parse-service] parse cache cleared (schema change)');
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
	): Promise<DocumentModel | null> {
		const rawText = document.getText();

		// Build qualify schema hint from already-cached indexer columns (fast, synchronous).
		// Also fire describe requests concurrently to populate schema_mapping for alias resolution
		// in a single bridge round-trip. DescribeCache deduplicates inflight requests.
		const qualifySchema: Record<string, Record<string, string>> = {};
		const parseRequest: Record<string, unknown> = {
			parse_document: true,
			sql: rawText,
			dialect: dialect || 'ansi',
		};

		if (this._enrichment) {
			const { indexer, describeCache } = this._enrichment;
			const { refs } = stripJinja(rawText, indexer);

			for (const [tableName, uniqueId] of refs) {
				const cols = indexer.getColumns(uniqueId);
				if (cols && cols.length > 0) {
					qualifySchema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c.toLowerCase(), 'varchar']));
				}
			}

			const schemaMapping = indexer.buildSchemaMapping();
			await Promise.all([...refs].map(async ([tableName, uniqueId]) => {
				const node = indexer.getRawNode(uniqueId);
				const isSource = uniqueId.startsWith('source.');
				const modelName = node && 'name' in node ? String(node.name) : tableName;
				const sourceName = isSource && node && 'source_name' in node ? String(node.source_name) : undefined;

				let qualifiedName: string | undefined;
				if (node) {
					const db = 'database' in node ? (node.database as string | undefined) : undefined;
					const schema = 'schema' in node ? (node.schema as string | undefined) : undefined;
					const identifier = isSource
						? ('identifier' in node ? String((node as { identifier: string }).identifier) : undefined)
						: (('alias' in node ? String((node as { alias?: string }).alias) : undefined) ?? modelName);
					const parts = [db, schema, identifier].filter(Boolean);
					if (parts.length > 1) qualifiedName = parts.join('.');
				}

				const cols = await describeCache.describeTable(uniqueId, modelName, sourceName, qualifiedName);
				if (cols && cols.length > 0) {
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

		const result = await this._bridge.invokeRaw(parseRequest);

		if (!result.success || !result.data) {
			const errMsg = (result.data as Record<string, unknown>)?.['error'] ?? 'no response';
			this._logger.debug(`[parse-service] parse_document failed for ${document.fileName}: ${String(errMsg)}`);
			return null;
		}

		const data = result.data as unknown as (DocumentModel & { success: boolean; sqlglotWarnings?: SqlglotWarning[]; aliases?: Record<string, string[]> });
		const model: DocumentModel = {
			ctes: data.ctes ?? [],
			refs: data.refs ?? [],
			sources: data.sources ?? [],
			finalColumns: data.finalColumns ?? [],
			tokens: (data as unknown as Record<string, unknown>).tokens as TokenInfo[] ?? [],
			timing: data.timing ?? { parseMs: 0, totalMs: 0 },
			sqlglotWarnings: data.sqlglotWarnings ?? [],
			aliases: data.aliases ?? {},
		};

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

	/** Remove cached entry when a document is closed. */
	evict(uri: vscode.Uri): void {
		this._cache.delete(uri.toString());
	}
}
