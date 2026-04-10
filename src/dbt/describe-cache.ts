import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { DbtExecutionService } from './execution-service';
import { Priority } from './execution-service';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DatabaseProvider } from '../providers/database/database-provider';

/**
 * Shared in-memory cache for describe_table results, keyed by dbt unique_id.
 *
 * Problem solved: calling describe_table hits a live database connection every
 * time. Multiple providers (completion, hover, diagnostics) and tools (column
 * lineage) may all need column info for the same model or source in the same
 * session. Without a cache every caller pays the round-trip cost independently.
 *
 * Strategy:
 * - Check indexer.getColumns(uniqueId) first — this survives across ColumnResolver
 *   cache invalidations (scoped to document version) but is invalidated correctly
 *   when the manifest changes (per-node diff in ManifestIndexer).
 * - If not cached, submit a describe_table bridge command and store the result
 *   via indexer.setColumns so all future callers (any provider or tool) benefit.
 * - Inflight dedup: if two callers request the same uniqueId concurrently the
 *   bridge is only called once; both await the same Promise.
 */
export class DescribeCache {
	private readonly _inflight = new Map<string, Promise<string[] | undefined>>();
	private _describeFailed = false;

	private readonly _onDescribeError = new vscode.EventEmitter<void>();
	/** Fired once when a describe operation fails for the first time. */
	readonly onDescribeError = this._onDescribeError.event;

	constructor(
		private readonly service: DbtExecutionService,
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private _provider: DatabaseProvider | null = null,
	) {}

	/**
	 * Set the DatabaseProvider to use for describe operations.
	 * When set, describe operations bypass the dbt bridge and use the provider directly.
	 * Can be set after construction when the provider is ready.
	 */
	setProvider(provider: DatabaseProvider): void {
		this._provider = provider;
	}

	/**
	 * Return the columns for the given dbt resource, fetching from the warehouse
	 * if not already cached. This is the preferred entry point — callers should
	 * not need to know whether the result comes from cache or a live describe.
	 */
	async columns(uniqueId: string): Promise<string[] | undefined> {
		const node = this.indexer.getRawNode(uniqueId);
		const isSource = uniqueId.startsWith('source.');
		const name = node && 'name' in node ? String(node.name) : uniqueId.split('.').pop() ?? uniqueId;
		const sourceName = isSource && node && 'source_name' in node ? String((node as { source_name: string }).source_name) : undefined;

		let qualifiedName: string | undefined;
		if (node) {
			const db = 'database' in node ? (node.database as string | undefined) : undefined;
			const schema = 'schema' in node ? (node.schema as string | undefined) : undefined;
			const identifier = isSource
				? ('identifier' in node ? String((node as { identifier: string }).identifier) : undefined)
				: (('alias' in node ? String((node as { alias?: string }).alias) : undefined) ?? name);
			const parts = [db, schema, identifier].filter(Boolean);
			if (parts.length > 1) qualifiedName = parts.join('.');
		}

		return this.describeTable(uniqueId, name, sourceName, qualifiedName);
	}

	/**
	 * Return the column list for the given resource, describing it via the
	 * bridge if not already cached.
	 *
	 * @deprecated Prefer `columns(uniqueId)` — it derives name/sourceName/qualifiedName
	 * from the manifest automatically and does not leak describe implementation details.
	 */
	async describeTable(
		uniqueId: string,
		name: string,
		sourceName?: string,
		qualifiedName?: string,
	): Promise<string[] | undefined> {
		const cached = this.indexer.getColumns(uniqueId);
		if (cached && !this.indexer.isManifestOnly(uniqueId)) {
			this.logger.trace(`DescribeCache: hit for ${uniqueId}`);
			return cached;
		}

		const inflight = this._inflight.get(uniqueId);
		if (inflight) {
			this.logger.trace(`DescribeCache: awaiting inflight for ${uniqueId}`);
			return inflight;
		}

		const promise = this._fetch(uniqueId, name, sourceName, qualifiedName);
		this._inflight.set(uniqueId, promise);
		try {
			return await promise;
		} finally {
			this._inflight.delete(uniqueId);
		}
	}

	private async _fetch(
		uniqueId: string,
		name: string,
		sourceName?: string,
		qualifiedName?: string,
	): Promise<string[] | undefined> {
		this.logger.trace(`DescribeCache: miss for ${uniqueId}, fetching from bridge`);
		try {
			// Prefer the DatabaseProvider when available (may bypass the dbt bridge queue)
			if (this._provider) {
				const defs = await this._provider.describe(name, { isSource: !!sourceName, sourceName, qualifiedName });
				const cols = defs.map(d => d.name).filter(Boolean);
				if (cols.length > 0) {
					this.indexer.setColumns(uniqueId, cols);
					this.logger.trace(`DescribeCache: stored ${cols.length} columns for ${uniqueId} (via provider)`);
					return cols;
				}
				return undefined;
			}

			// Fallback: use the dbt bridge describe_table command
			const result = await this.service.submit({
				type: 'describe',
				raw: sourceName
					? { describe_table: true, name, source_name: sourceName }
					: { describe_table: true, name },
				priority: Priority.Provider,
				origin: 'provider',
				label: `describe ${name}`,
			});
			const cols = (result.data as Record<string, unknown> | undefined)?.columns as string[] | undefined;
			if (cols && cols.length > 0) {
				this.indexer.setColumns(uniqueId, cols);
				this.logger.trace(`DescribeCache: stored ${cols.length} columns for ${uniqueId}`);
				return cols;
			}
		} catch (err) {
			this.logger.warn(`DescribeCache: error describing ${uniqueId}: ${err}`);
			if (!this._describeFailed) {
				this._describeFailed = true;
				this._onDescribeError.fire();
			}
		}
		return undefined;
	}
}
