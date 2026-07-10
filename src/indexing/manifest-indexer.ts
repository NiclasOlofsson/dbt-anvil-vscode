import * as path from 'node:path';
import type { DbtManifest, DbtMacroArgument, DbtNode, DbtSource, ResourceType } from '../dbt/manifest-types';
import { ManifestLoader } from '../dbt/manifest-loader';
import type { ILogger } from '../types/logger';
import { classifyLayer, type LayerConfig, type LayerInfo } from './layer-classifier';
import { makeTemplateProvider } from '../ftl/sqllens/template-shape';
import type { TemplateProvider } from '../ftl/sqllens/api';

export interface LineageNode {
	uniqueId: string;
	name: string;
	type: string;
	distance: number;
}

export interface ModelLineage {
	upstream: LineageNode[];
	downstream: LineageNode[];
	stats: {
		upstream_count: number;
		downstream_count: number;
		total_dependencies: number;
	};
}

export interface IndexedModel {
	uniqueId: string;
	name: string;
	packageName: string;
	path: string;
	schema?: string;
	database?: string;
	alias?: string;
	relationName?: string;
	tags: string[];
	materialisation: string;
	description?: string;
	/** Resolved layer (dbt Anvil-local classification). Undefined if no configured layer matches. */
	layer?: LayerInfo;
}

export interface IndexedSource {
	uniqueId: string;
	name: string;
	sourceName: string;
	schema: string;
	database?: string;
	identifier?: string;
	relationName?: string;
	description?: string;
	tags: string[];
}

export interface IndexedMacro {
	uniqueId: string;
	name: string;
	packageName: string;
	filePath?: string;
	description?: string;
	arguments: DbtMacroArgument[];
	/** Raw macro source (`macro_sql`), used to classify its template expansion shape (C4). */
	macroSql?: string;
}

export interface ManifestIndex {
	models: Map<string, IndexedModel>;
	sources: Map<string, IndexedSource>;
	macros: Map<string, IndexedMacro>;
	nodesByName: Map<string, string[]>; // name → unique_ids (can have duplicates across packages)
	parentMap: Map<string, string[]>;
	childMap: Map<string, string[]>;
	dbtVersion: string;
	adapterType?: string;
	buildTime: Date;
}

export type ColumnCacheOrigin = 'describe' | 'parse' | 'database_columns' | 'persisted' | 'unknown';

interface ColumnCacheEntry {
	columns: string[];
	origin: ColumnCacheOrigin;
}

/**
 * Builds an in-memory index from the dbt manifest for fast lookups.
 */
export class ManifestIndexer {
	private _index: ManifestIndex | null = null;

	/**
	 * Global column store. Keyed by unique node ID (e.g. "model.jaffle_shop.stg_customers").
	 * Populated lazily by the completion provider via setColumns().
	 * Cleared selectively when a model changes (model + all downstream dependents).
	 */
	private _columnStore = new Map<string, ColumnCacheEntry>();

	/** Checksums from the previous manifest build, used to diff on rebuild. */
	private _nodeChecksums = new Map<string, string>();

	/** The load result from the last successful build, used to detect no-change reloads. */
	private _lastLoadResult: import('../dbt/manifest-loader').ManifestLoadResult | null = null;

	private _layerConfigs: LayerConfig[] = [];

	constructor(
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) { }

	/**
	 * Replace the layer configuration and re-classify all indexed models in-place.
	 * Safe to call any time; triggers no manifest reload.
	 */
	setLayerConfigs(configs: LayerConfig[]): void {
		this._layerConfigs = configs;
		if (!this._index) return;
		const projectDir = this.loader.projectDir;
		for (const model of this._index.models.values()) {
			model.layer = classifyLayer(model, configs, { projectDir });
		}
		this.logger.info(`Layer classification refreshed for ${this._index.models.size} models (${configs.length} layers configured)`);
	}

	getLayerConfigs(): LayerConfig[] {
		return this._layerConfigs;
	}

	/**
	 * The raw dbt adapter type from the manifest or profiles.yml.
	 * Returns the raw dbt value (e.g. 'postgresql', 'synapse') — dialect mapping
	 * is deferred to the SQL parsing layer (SqllensDocumentParser).
	 */
	get adapterType(): string | undefined {
		return this.loader.resolveDialect();
	}

	/**
	 * C4 template-catalog seam consumed by `SqllensDocumentParser` (via `AdapterContext`):
	 * a `parseTemplated` `shapeOf` that classifies a macro-call's expansion shape by name,
	 * lazily, from the indexed macros' `macroSql`. Only macros that actually appear as
	 * `{{ }}` tags are classified, and the classifier answers `statement` (or nothing), so a
	 * macro-generated query body parses natively instead of hitting the blank cascade. Reads
	 * the current index each call, so it stays fresh across re-indexes.
	 */
	get templateProvider(): TemplateProvider {
		return makeTemplateProvider(name => this.findMacroByName(name)?.macroSql);
	}

	/**
	 * Build or rebuild the index from the current manifest.
	 */
	build(force = false): ManifestIndex {
		if (!force && this._index) {
			return this._index;
		}

		this.logger.info('Building manifest index...');
		const loadResult = this.loader.load(force);

		// If the loader returned the exact same result (mtime unchanged), skip everything
		if (this._index && loadResult === this._lastLoadResult) {
			this.logger.info('Manifest unchanged on disk, skipping rebuild');
			return this._index;
		}

		this._lastLoadResult = loadResult;
		this._index = this._buildIndex(loadResult.manifest);
		this._diffAndInvalidate(loadResult.manifest);
		this.logger.info(
			`Manifest index built: ${this._index.models.size} models, ${this._index.sources.size} sources`,
		);
		return this._index;
	}

	get index(): ManifestIndex | null {
		return this._index;
	}

	get projectDir(): string {
		return this.loader.projectDir;
	}

	manifestExists(): boolean {
		return this.loader.manifestExists();
	}

	private _buildIndex(manifest: DbtManifest): ManifestIndex {
		const models = new Map<string, IndexedModel>();
		const sources = new Map<string, IndexedSource>();
		const macros = new Map<string, IndexedMacro>();
		const nodesByName = new Map<string, string[]>();

		// Index nodes (models, seeds, snapshots, analyses)
		const projectDir = this.loader.projectDir;
		for (const [uid, node] of Object.entries(manifest.nodes)) {
			if (isIndexableNode(node.resource_type)) {
				const indexed: IndexedModel = {
					uniqueId: uid,
					name: node.name,
					packageName: node.package_name,
					path: path.join(projectDir, node.original_file_path),
					schema: node.schema,
					database: node.database,
					alias: node.alias,
					relationName: node.relation_name,
					tags: node.tags ?? [],
					materialisation: node.config?.materialized ?? 'view',
					description: node.description,
				};
				indexed.layer = classifyLayer(indexed, this._layerConfigs, { projectDir });
				models.set(uid, indexed);

				// Build name lookup
				if (!nodesByName.has(node.name)) {
					nodesByName.set(node.name, []);
				}
				nodesByName.get(node.name)!.push(uid);
			}
		}

		// Index sources
		for (const [uid, source] of Object.entries(manifest.sources)) {
			const indexed: IndexedSource = {
				uniqueId: uid,
				name: source.name,
				sourceName: source.source_name,
				schema: source.schema,
				database: source.database,
				identifier: source.identifier,
				relationName: source.relation_name,
				description: source.description,
				tags: source.tags ?? [],
			};
			sources.set(uid, indexed);

			// Also add sources to name lookup
			const sourceKey = `${source.source_name}.${source.name}`;
			if (!nodesByName.has(sourceKey)) {
				nodesByName.set(sourceKey, []);
			}
			nodesByName.get(sourceKey)!.push(uid);
		}

		// Index macros (skip dbt core internal macros)
		for (const [uid, macro] of Object.entries(manifest.macros)) {
			if (macro.package_name === 'dbt') continue;
			macros.set(uid, {
				uniqueId: uid,
				name: macro.name,
				packageName: macro.package_name,
				filePath: macro.original_file_path
					? path.join(this.loader.projectDir, macro.original_file_path)
					: undefined,
				description: macro.description,
				arguments: macro.arguments ?? [],
				macroSql: macro.macro_sql,
			});
		}

		// Build parent/child maps
		const parentMap = new Map<string, string[]>();
		const childMap = new Map<string, string[]>();

		for (const [uid, parents] of Object.entries(manifest.parent_map)) {
			parentMap.set(uid, parents);
		}
		for (const [uid, children] of Object.entries(manifest.child_map)) {
			childMap.set(uid, children);
		}

		return {
			models,
			sources,
			macros,
			nodesByName,
			parentMap,
			childMap,
			dbtVersion: manifest.metadata.dbt_version,
			adapterType: manifest.metadata.adapter_type?.toLowerCase(),
			buildTime: new Date(),
		};
	}

	/**
	 * Look up a model by name. Returns all matches (may be multiple across packages).
	 */
	findModelsByName(name: string): IndexedModel[] {
		const index = this._index;
		if (!index) return [];
		const uids = index.nodesByName.get(name) ?? [];
		return uids.flatMap(uid => {
			const m = index.models.get(uid);
			return m ? [m] : [];
		});
	}

	/**
	 * Find any resource by name, optionally filtered by resource type prefix.
	 */
	findResource(name: string, resourceType?: string): Array<{ uniqueId: string; name: string; type: string }> {
		const index = this._index;
		if (!index) return [];

		const results: Array<{ uniqueId: string; name: string; type: string }> = [];

		// Search nodesByName first (models, seeds, snapshots, analyses, sources)
		const uids = index.nodesByName.get(name) ?? [];
		for (const uid of uids) {
			const type = uid.split('.')[0];
			if (resourceType && type !== resourceType) continue;

			const m = index.models.get(uid);
			if (m) {
				results.push({ uniqueId: uid, name: m.name, type });
				continue;
			}
			const s = index.sources.get(uid);
			if (s) {
				results.push({ uniqueId: uid, name: s.name, type });
			}
		}

		// Also search sources by table name only (without source_name prefix)
		if (!resourceType || resourceType === 'source') {
			for (const [uid, source] of index.sources) {
				if (source.name === name && !results.some(r => r.uniqueId === uid)) {
					results.push({ uniqueId: uid, name: source.name, type: 'source' });
				}
			}
		}

		// Also search models by name directly
		if (!resourceType || resourceType === 'model') {
			for (const [uid, model] of index.models) {
				if (model.name === name && !results.some(r => r.uniqueId === uid)) {
					const type = uid.split('.')[0];
					results.push({ uniqueId: uid, name: model.name, type });
				}
			}
		}

		return results;
	}

	/**
	 * Get lineage for a node with independent upstream/downstream depth.
	 */
	getLineage(uniqueId: string, upstreamDepth = 2, downstreamDepth = 2): ModelLineage {
		const index = this._index;
		const empty = { upstream: [], downstream: [], stats: { upstream_count: 0, downstream_count: 0, total_dependencies: 0 } };
		if (!index) return empty;

		const upstream = upstreamDepth > 0
			? this._traverse(index.parentMap, uniqueId, upstreamDepth, index)
			: [];
		const downstream = downstreamDepth > 0
			? this._traverse(index.childMap, uniqueId, downstreamDepth, index)
			: [];

		return {
			upstream,
			downstream,
			stats: {
				upstream_count: upstream.length,
				downstream_count: downstream.length,
				total_dependencies: upstream.length + downstream.length,
			},
		};
	}

	private _traverse(map: Map<string, string[]>, startId: string, maxDepth: number, index: ManifestIndex): LineageNode[] {
		const visited = new Map<string, number>(); // uid -> distance
		const queue: [string, number][] = [[startId, 0]];

		while (queue.length > 0) {
			const [current, depth] = queue.shift()!;
			if (depth >= maxDepth) continue;
			const neighbours = map.get(current) ?? [];
			for (const n of neighbours) {
				if (!visited.has(n)) {
					visited.set(n, depth + 1);
					queue.push([n, depth + 1]);
				}
			}
		}

		visited.delete(startId);
		return [...visited.entries()].map(([uid, distance]) => {
			const m = index.models.get(uid);
			const s = index.sources.get(uid);
			const name = m?.name ?? s?.name ?? uid.split('.').pop() ?? uid;
			const type = uid.split('.')[0];
			return { uniqueId: uid, name, type, distance };
		});
	}

	/**
	 * Get all models with a given tag.
	 */
	findByTag(tag: string): IndexedModel[] {
		const index = this._index;
		if (!index) return [];
		const results: IndexedModel[] = [];
		for (const model of index.models.values()) {
			if (model.tags.includes(tag)) {
				results.push(model);
			}
		}
		return results;
	}

	/**
	 * Get full raw DbtNode from manifest for a unique ID.
	 */
	getRawNode(uniqueId: string): DbtNode | DbtSource | undefined {
		const { manifest } = this.loader.load();
		return manifest.nodes[uniqueId] ?? manifest.sources[uniqueId];
	}

	/**
	 * Find a source by (sourceName, tableName) key.
	 * Returns the uid and the indexed source, or undefined if not found.
	 */
	findSourceByKey(sourceName: string, tableName: string): { uid: string; source: IndexedSource } | undefined {
		const index = this._index;
		if (!index) return undefined;
		const key = `${sourceName}.${tableName}`;
		const uids = index.nodesByName.get(key);
		if (uids && uids.length > 0) {
			const source = index.sources.get(uids[0]);
			if (source) return { uid: uids[0], source };
		}
		return undefined;
	}

	/**
	 * Find a macro by exact name (case-sensitive).
	 */
	findMacroByName(name: string): IndexedMacro | undefined {
		const index = this._index;
		if (!index) return undefined;
		for (const macro of index.macros.values()) {
			if (macro.name === name) return macro;
		}
		return undefined;
	}

	/**
	 * Find macros whose name starts with the given prefix (case-insensitive).
	 */
	findMacrosByPrefix(prefix: string): IndexedMacro[] {
		const index = this._index;
		if (!index) return [];
		const lowerPrefix = prefix.toLowerCase();
		const results: IndexedMacro[] = [];
		for (const macro of index.macros.values()) {
			if (macro.name.toLowerCase().startsWith(lowerPrefix)) {
				results.push(macro);
			}
		}
		return results;
	}

	// -----------------------------------------------------------------------
	// Global column store — lazy-populated, DAG-aware invalidation
	// -----------------------------------------------------------------------

	getColumns(uniqueId: string): string[] | undefined {
		return this._columnStore.get(uniqueId)?.columns;
	}

	setColumns(uniqueId: string, columns: string[], origin: ColumnCacheOrigin = 'unknown'): void {
		this._columnStore.set(uniqueId, { columns, origin });
	}

	/**
	 * Pre-populate the column store and node checksums from persisted cache data.
	 * Must be called BEFORE the first build() so _diffAndInvalidate sees non-zero
	 * checksums and only evicts nodes that actually changed, rather than clearing
	 * the entire store.
	 */
	seedFromCache(data: { columns: Record<string, string[]>; checksums: Record<string, string> }): void {
		for (const [uid, cols] of Object.entries(data.columns)) {
			this._columnStore.set(uid, { columns: cols, origin: 'persisted' });
		}
		for (const [uid, checksum] of Object.entries(data.checksums)) {
			this._nodeChecksums.set(uid, checksum);
		}
		this.logger.debug(`Column store: seeded ${this._columnStore.size} entries from cache`);
	}

	/**
	 * Export the current column store and node checksums for persistence.
	 */
	exportForCache(): { columns: Record<string, string[]>; checksums: Record<string, string> } {
		const columns = Object.fromEntries(
			[...this._columnStore]
				.map(([uid, entry]) => [uid, entry.columns]),
		);
		return {
			columns,
			checksums: Object.fromEntries(this._nodeChecksums),
		};
	}

	/**
	 * Invalidate columns for a model and all its transitive downstream dependents.
	 * Returns the set of unique IDs that were evicted.
	 */
	invalidateModel(uniqueId: string): Set<string> {
		const visited = new Set<string>();
		const evicted = new Set<string>();
		this._evictDownstream(uniqueId, visited, evicted);
		if (evicted.size > 0) {
			this.logger.debug(`Column store: evicted ${evicted.size} entries: [${[...evicted].join(', ')}]`);
		}
		return evicted;
	}

	/**
	 * Compare node checksums from the new manifest against the previous build.
	 * Only invalidate column store entries for nodes that actually changed.
	 * On first build (no previous checksums), clears everything.
	 */
	private _diffAndInvalidate(manifest: DbtManifest): void {
		const newChecksums = new Map<string, string>();
		for (const [uid, node] of Object.entries(manifest.nodes)) {
			if (node.checksum?.checksum) {
				newChecksums.set(uid, node.checksum.checksum);
			}
		}

		const oldChecksums = this._nodeChecksums;
		this._nodeChecksums = newChecksums;

		// First build — no previous state to compare against
		if (oldChecksums.size === 0) {
			this.clearColumnStore();
			return;
		}

		// Find nodes that changed, were added, or were removed
		const changed = new Set<string>();
		for (const [uid, checksum] of newChecksums) {
			const prev = oldChecksums.get(uid);
			if (prev !== checksum) {
				changed.add(uid);
			}
		}
		// Removed nodes
		for (const uid of oldChecksums.keys()) {
			if (!newChecksums.has(uid)) {
				changed.add(uid);
			}
		}

		if (changed.size === 0) {
			this.logger.info('Manifest rebuilt — no node changes detected, column store preserved');
			return;
		}

		this.logger.info(`Manifest rebuilt — ${changed.size} node(s) changed: [${[...changed].join(', ')}]`);
		for (const uid of changed) {
			this.invalidateModel(uid);
		}
	}

	/** Clear the entire column store (e.g. on full manifest rebuild). */
	clearColumnStore(manifest?: DbtManifest): void {
		const size = this._columnStore.size;
		this._columnStore.clear();
		if (size > 0) {
			this.logger.debug(`Column store: cleared all ${size} entries`);
		}
		void manifest;
	}

	/**
	 * Find the unique ID of a model by its file path.
	 * Returns undefined if no model matches.
	 */
	findModelByFilePath(filePath: string): string | undefined {
		const index = this._index;
		if (!index) return undefined;
		const normalised = filePath.replace(/\\/g, '/').toLowerCase();
		for (const model of index.models.values()) {
			if (model.path.replace(/\\/g, '/').toLowerCase() === normalised) {
				return model.uniqueId;
			}
		}
		return undefined;
	}

	private _evictDownstream(uniqueId: string, visited: Set<string>, evicted: Set<string>): void {
		if (visited.has(uniqueId)) return;
		visited.add(uniqueId);
		const hadColumns = this._columnStore.delete(uniqueId);
		if (hadColumns) {
			evicted.add(uniqueId);
		}
		const children = this._index?.childMap.get(uniqueId) ?? [];
		// Only recurse if this node had columns or has children that might
		if (children.length === 0) return;
		for (const child of children) {
			this._evictDownstream(child, visited, evicted);
		}
	}
}

function isIndexableNode(resourceType: ResourceType): boolean {
	return ['model', 'seed', 'snapshot', 'analysis'].includes(resourceType);
}
