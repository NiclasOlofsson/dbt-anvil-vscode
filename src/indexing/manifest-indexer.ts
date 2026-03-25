import * as path from 'node:path';
import type { DbtManifest, DbtMacroArgument, DbtNode, DbtSource, ResourceType } from '../dbt/manifest-types';
import { ManifestLoader } from '../dbt/manifest-loader';
import type { ILogger } from '../types/logger';

export interface ModelLineage {
	upstream: string[];
	downstream: string[];
}

export interface IndexedModel {
	uniqueId: string;
	name: string;
	packageName: string;
	path: string;
	schema?: string;
	database?: string;
	tags: string[];
	materialisation: string;
	description?: string;
}

export interface IndexedSource {
	uniqueId: string;
	name: string;
	sourceName: string;
	schema: string;
	database?: string;
	description?: string;
	tags: string[];
}

export interface IndexedMacro {
	uniqueId: string;
	name: string;
	packageName: string;
	description?: string;
	arguments: DbtMacroArgument[];
}

export interface ManifestIndex {
	models: Map<string, IndexedModel>;
	sources: Map<string, IndexedSource>;
	macros: Map<string, IndexedMacro>;
	nodesByName: Map<string, string[]>; // name → unique_ids (can have duplicates across packages)
	parentMap: Map<string, string[]>;
	childMap: Map<string, string[]>;
	dbtVersion: string;
	adapterType: string;
	buildTime: Date;
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
	private _columnStore = new Map<string, string[]>();

	/** Checksums from the previous manifest build, used to diff on rebuild. */
	private _nodeChecksums = new Map<string, string>();

	constructor(
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	/**
	 * Build or rebuild the index from the current manifest.
	 */
	build(force = false): ManifestIndex {
		if (!force && this._index) {
			return this._index;
		}

		this.logger.info('Building manifest index...');
		const { manifest } = this.loader.load(force);
		this._index = this._buildIndex(manifest);
		this._diffAndInvalidate(manifest);
		this.logger.info(
			`Manifest index built: ${this._index.models.size} models, ${this._index.sources.size} sources`,
		);
		return this._index;
	}

	get index(): ManifestIndex | null {
		return this._index;
	}

	private _buildIndex(manifest: DbtManifest): ManifestIndex {
		const models = new Map<string, IndexedModel>();
		const sources = new Map<string, IndexedSource>();
		const macros = new Map<string, IndexedMacro>();
		const nodesByName = new Map<string, string[]>();

		// Index nodes (models, seeds, snapshots, analyses)
		for (const [uid, node] of Object.entries(manifest.nodes)) {
			if (isIndexableNode(node.resource_type)) {
				const indexed: IndexedModel = {
					uniqueId: uid,
					name: node.name,
					packageName: node.package_name,
					path: path.join(this.loader.projectDir, node.original_file_path),
					schema: node.schema,
					database: node.database,
					tags: node.tags ?? [],
					materialisation: node.config?.materialized ?? 'view',
					description: node.description,
				};
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
				description: macro.description,
				arguments: macro.arguments ?? [],
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
			adapterType: manifest.metadata.adapter_type ?? 'ansi',
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
	 * Get lineage for a node (up to depth levels).
	 */
	getLineage(uniqueId: string, depth = 3, direction: 'both' | 'upstream' | 'downstream' = 'both'): ModelLineage {
		const index = this._index;
		if (!index) return { upstream: [], downstream: [] };

		const upstream = direction === 'downstream'
			? []
			: this._traverse(index.parentMap, uniqueId, depth);
		const downstream = direction === 'upstream'
			? []
			: this._traverse(index.childMap, uniqueId, depth);

		return { upstream, downstream };
	}

	private _traverse(map: Map<string, string[]>, startId: string, maxDepth: number): string[] {
		const visited = new Set<string>();
		const queue: [string, number][] = [[startId, 0]];

		while (queue.length > 0) {
			const [current, depth] = queue.shift()!;
			if (depth >= maxDepth) continue;
			const neighbours = map.get(current) ?? [];
			for (const n of neighbours) {
				if (!visited.has(n)) {
					visited.add(n);
					queue.push([n, depth + 1]);
				}
			}
		}

		visited.delete(startId);
		return [...visited];
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
	/**
	 * Build a schema mapping for all models and sources with documented columns.
	 * Shape: {database: {schema: {table: {column: {}}}}}
	 */
	buildSchemaMapping(): Record<string, Record<string, Record<string, Record<string, object>>>> {
		const mapping: Record<string, Record<string, Record<string, Record<string, object>>>> = {};
		const { manifest } = this.loader.load();

		const addNode = (raw: { database?: string; schema?: string; name: string; columns: Record<string, unknown> }) => {
			if (!raw.columns || Object.keys(raw.columns).length === 0) return;
			const db = (raw.database ?? '__default__').toLowerCase();
			const schema = (raw.schema ?? '__default__').toLowerCase();
			const table = raw.name.toLowerCase();
			mapping[db] ??= {};
			mapping[db][schema] ??= {};
			mapping[db][schema][table] = Object.fromEntries(
				Object.keys(raw.columns).map(col => [col, {}]),
			);
		};

		for (const node of Object.values(manifest.nodes)) {
			if (isIndexableNode(node.resource_type)) {
				addNode(node);
			}
		}
		for (const source of Object.values(manifest.sources)) {
			addNode({ database: source.database, schema: source.schema, name: source.identifier ?? source.name, columns: source.columns });
		}

		return mapping;
	}

	// -----------------------------------------------------------------------
	// Global column store — lazy-populated, DAG-aware invalidation
	// -----------------------------------------------------------------------

	getColumns(uniqueId: string): string[] | undefined {
		return this._columnStore.get(uniqueId);
	}

	setColumns(uniqueId: string, columns: string[]): void {
		this._columnStore.set(uniqueId, columns);
	}

	/**
	 * Invalidate columns for a model and all its transitive downstream dependents.
	 * Returns the set of unique IDs that were evicted.
	 */
	invalidateModel(uniqueId: string): Set<string> {
		const evicted = new Set<string>();
		this._evictDownstream(uniqueId, evicted);
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
	clearColumnStore(): void {
		const size = this._columnStore.size;
		this._columnStore.clear();
		if (size > 0) {
			this.logger.debug(`Column store: cleared all ${size} entries`);
		}
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

	private _evictDownstream(uniqueId: string, visited: Set<string>): void {
		if (visited.has(uniqueId)) return;
		visited.add(uniqueId);
		this._columnStore.delete(uniqueId);
		const children = this._index?.childMap.get(uniqueId) ?? [];
		for (const child of children) {
			this._evictDownstream(child, visited);
		}
	}
}

function isIndexableNode(resourceType: ResourceType): boolean {
	return ['model', 'seed', 'snapshot', 'analysis'].includes(resourceType);
}
