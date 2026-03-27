import type { ILogger } from '../types/logger';
import type { DbtExecutionService } from './execution-service';
import { Priority } from './execution-service';

/**
 * Cache for scope_columns results, keyed by a hash of (compiled SQL + schema mapping).
 *
 * When the same SQL and schema mapping are submitted again, the cached
 * aliases are returned immediately — no queue round-trip.
 *
 * Invalidation: entries are evicted when the document version changes (new
 * content hash) or when the column store is updated for any referenced table
 * (schema mapping changes → different hash).
 */
export class ScopeColumnsCache {
	private readonly _cache = new Map<string, Record<string, string[]>>();
	private readonly _inflight = new Map<string, Promise<Record<string, string[]>>>();

	constructor(
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
	) {}

	async scopeColumns(
		sql: string,
		dialect: string,
		schemaMapping: Record<string, Record<string, Record<string, Record<string, object>>>>,
	): Promise<Record<string, string[]>> {
		const key = this._hash(sql, dialect, schemaMapping);

		const cached = this._cache.get(key);
		if (cached) {
			this.logger.trace('ScopeColumnsCache: hit');
			return cached;
		}

		const inflight = this._inflight.get(key);
		if (inflight) {
			this.logger.trace('ScopeColumnsCache: awaiting inflight');
			return inflight;
		}

		const promise = this._fetch(sql, dialect, schemaMapping, key);
		this._inflight.set(key, promise);
		try {
			return await promise;
		} finally {
			this._inflight.delete(key);
		}
	}

	clear(): void {
		this._cache.clear();
	}

	private async _fetch(
		sql: string,
		dialect: string,
		schemaMapping: Record<string, Record<string, Record<string, Record<string, object>>>>,
		key: string,
	): Promise<Record<string, string[]>> {
		const result = await this.service.submit({
			type: 'scope_columns',
			raw: { get_scope_columns: true, sql, dialect, schema_mapping: schemaMapping },
			priority: Priority.Provider,
			origin: 'provider',
			label: 'get scope columns',
		});

		const data = result.data as Record<string, unknown> | undefined;
		const aliases = (data?.aliases as Record<string, string[]>) ?? {};
		this._cache.set(key, aliases);
		this.logger.trace(`ScopeColumnsCache: stored (${Object.keys(aliases).length} aliases)`);
		return aliases;
	}

	/** Fast non-cryptographic hash of the inputs. */
	private _hash(
		sql: string,
		dialect: string,
		schemaMapping: Record<string, Record<string, Record<string, Record<string, object>>>>,
	): string {
		const input = sql + '\0' + dialect + '\0' + JSON.stringify(schemaMapping);
		let h = 0;
		for (let i = 0; i < input.length; i++) {
			h = ((h << 5) - h + input.charCodeAt(i)) | 0;
		}
		return h.toString(36);
	}
}
