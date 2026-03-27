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
	 * Return the column list for the given resource, describing it via the
	 * bridge if not already cached.
	 *
	 * `uniqueId`   — dbt unique_id (e.g. "model.project.orders" or "source.project.raw.orders")
	 * `name`       — table/model name used in the describe_table command
	 * `sourceName` — source name (only for source nodes)
	 */
	async describeTable(
		uniqueId: string,
		name: string,
		sourceName?: string,
	): Promise<string[] | undefined> {
		const cached = this.indexer.getColumns(uniqueId);
		if (cached) {
			this.logger.trace(`DescribeCache: hit for ${uniqueId}`);
			return cached;
		}

		const inflight = this._inflight.get(uniqueId);
		if (inflight) {
			this.logger.trace(`DescribeCache: awaiting inflight for ${uniqueId}`);
			return inflight;
		}

		const promise = this._fetch(uniqueId, name, sourceName);
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
	): Promise<string[] | undefined> {
		this.logger.trace(`DescribeCache: miss for ${uniqueId}, fetching from bridge`);
		try {
			// Prefer the DatabaseProvider when available (may bypass the dbt bridge queue)
			if (this._provider) {
				const defs = await this._provider.describe(name, { isSource: !!sourceName, sourceName });
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
		}
		return undefined;
	}
}
