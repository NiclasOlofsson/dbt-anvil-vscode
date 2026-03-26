import * as vscode from 'vscode';
import type { DbtExecutionService } from '../dbt/execution-service';
import { Priority } from '../dbt/execution-service';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { DescribeCache } from '../dbt/describe-cache';
import { stripJinja } from './jinja-utils';

/**
 * Shared column resolution service.  Resolves alias → column-name mappings
 * for SQL files by calling the bridge's `get_scope_columns` command.
 *
 * Results are cached per document URI + version so multiple providers
 * (completion, hover, diagnostics) can share a single bridge round-trip.
 */
export class ColumnResolver {
	private _scopeCache = new Map<string, { version: number; aliases: Record<string, string[]> }>();
	private _scopeInFlight = new Map<string, Promise<Record<string, string[]>>>();
	private readonly _describeCache: DescribeCache | undefined;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly service?: DbtExecutionService,
		describeCache?: DescribeCache,
	) {
		this._describeCache = describeCache ?? (service ? new DescribeCache(service, indexer, logger) : undefined);
	}

	/** Drop all cached scopes (e.g. after manifest reload). */
	invalidateCache(): void {
		this._scopeCache.clear();
		this.logger.debug('ColumnResolver: scope cache invalidated');
	}

	/**
	 * Return cached aliases for the given document **without** triggering a
	 * bridge call.  Returns `null` when no cached value exists for the current
	 * document version.
	 */
	getCachedAliases(document: vscode.TextDocument): Record<string, string[]> | null {
		const cached = this._scopeCache.get(document.uri.toString());
		if (cached && cached.version === document.version) return cached.aliases;
		return null;
	}

	/**
	 * Resolve alias → column-name mappings for a document.  Uses an in-memory
	 * cache keyed by `(uri, version)` so repeated calls within the same
	 * document version are free.
	 */
	async getScopeAliases(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<Record<string, string[]>> {
		const key = document.uri.toString();
		const cached = this._scopeCache.get(key);
		if (cached && cached.version === document.version) {
			this.logger.debug('ColumnResolver: cache hit');
			return cached.aliases;
		}

		if (!this.service) return {};

		const inflightKey = `${key}@${document.version}`;
		const inflight = this._scopeInFlight.get(inflightKey);
		if (inflight) {
			this.logger.debug('ColumnResolver: awaiting in-flight request');
			return inflight;
		}

		const promise = this._resolve(document, key, token);
		this._scopeInFlight.set(inflightKey, promise);
		try {
			return await promise;
		} finally {
			this._scopeInFlight.delete(inflightKey);
		}
	}

	// ------------------------------------------------------------------
	// Internal
	// ------------------------------------------------------------------

	private async _resolve(
		document: vscode.TextDocument,
		cacheKey: string,
		token: vscode.CancellationToken,
	): Promise<Record<string, string[]>> {
		if (!this.service) return {};

		const { sql, refs } = stripJinja(document.getText(), this.indexer);
		if (!sql) return {};

		const schemaMapping = this.indexer.buildSchemaMapping();
		const adapterType = this.indexer.index?.adapterType ?? 'ansi';

		// Describe upstream tables to fill schema_mapping with column info
		for (const [tableName, uniqueId] of refs) {
			if (token.isCancellationRequested) return {};

			if (!this._describeCache) continue;

			const node = this.indexer.getRawNode(uniqueId);
			const isSource = uniqueId.startsWith('source.');
			const modelName = node && 'name' in node ? node.name : tableName;
			const sourceName = isSource && node && 'source_name' in node ? node.source_name : undefined;

			this.logger.debug(`ColumnResolver describe: ${tableName} (${uniqueId})`);
			const cols = await this._describeCache.describeTable(uniqueId, modelName, sourceName);
			if (cols && cols.length > 0) {
				const db = (schemaMapping['__described__'] ??= {});
				const schema = (db['__described__'] ??= {});
				schema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c, {}]));
			}
		}

		if (token.isCancellationRequested) return {};

		const result = await this.service.submit({
			type: 'scope_columns',
			raw: { get_scope_columns: true, sql, dialect: adapterType, schema_mapping: schemaMapping },
			priority: Priority.Provider,
			origin: 'provider',
			label: 'get scope columns',
		});

		const data = result.data as Record<string, unknown> | undefined;
		const aliases: Record<string, string[]> = (data?.aliases as Record<string, string[]>) ?? {};

		this._scopeCache.set(cacheKey, { version: document.version, aliases });
		return aliases;
	}
}
