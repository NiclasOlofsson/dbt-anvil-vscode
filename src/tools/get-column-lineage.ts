import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { CompileCache } from '../dbt/compile-cache';
import type { DescribeCache } from '../dbt/describe-cache';
import type { ColumnDependency, LineageResult } from '../ftl/ftl-document-parser';
import type { DocumentParser } from '../services/document-parser';
import { toolResult } from './tool-helpers';

interface GetColumnLineageInput {
	model: string;
	column: string;
	direction?: 'upstream' | 'downstream' | 'both';
	depth?: number;
}

// Schema mapping shape sent to the bridge: {database: {schema: {table: {col: type}}}}
type SchemaMapping = Record<string, Record<string, Record<string, Record<string, string>>>>;

export class GetColumnLineageTool implements vscode.LanguageModelTool<GetColumnLineageInput> {
	private readonly _manifestFallbackWarned = new Set<string>();

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly compileCache: CompileCache,
		private readonly describeCache: DescribeCache,
		private readonly ftlParser: DocumentParser,
	) {}

	private _isResolvedColumns(columns: string[] | undefined): columns is string[] {
		return Boolean(columns && columns.length > 0 && !columns.includes('*'));
	}

	private _rawDatabaseColumns(raw: ReturnType<ManifestIndexer['getRawNode']>): string[] {
		if (!raw) return [];
		type RawRecord = Record<string, unknown>;
		const r = raw as unknown as RawRecord;
		const dbCols = r['database_columns'];
		if (!Array.isArray(dbCols) || dbCols.length === 0) return [];
		return (dbCols as Array<{ col_name?: string }>)
			.filter(c => c.col_name)
			.map(c => c.col_name as string);
	}

	/**
	 * Build sqlglot schema mapping from upstream nodes.
	 * Tries database_columns (list from warehouse) first, then manifest columns dict.
	 * Format: {database: {schema: {table: {column: type}}}}
	 * Ported from dbt-core-mcp get_column_lineage._build_schema_mapping.
	 */
	private async _buildSchemaMapping(
		upstreamIds: string[],
		memo: Map<string, string[]>,
		resolving: Set<string>,
	): Promise<SchemaMapping> {
		this.logger.trace(`[columns] build schema mapping for ${upstreamIds.length} upstream nodes`);
		const mapping: SchemaMapping = {};
		const tablePriority = new Map<string, number>();
		for (const uid of upstreamIds) {
			const raw = this.indexer.getRawNode(uid);
			if (!raw) continue;
			type RawRecord = Record<string, unknown>;
			const r = raw as unknown as RawRecord;

			const db = (typeof r['database'] === 'string' ? r['database'] : undefined) ?? '__default__';
			const schema = (typeof r['schema'] === 'string' ? r['schema'] : undefined) ?? '__default__';
			// Use identifier (sources) or alias/name (models/seeds)
			const table = ((typeof r['identifier'] === 'string' ? r['identifier'] : undefined)
				?? (typeof r['alias'] === 'string' ? r['alias'] : undefined)
				?? raw.name).toLowerCase();

			let columnMap: Record<string, string> | undefined;

			// Parse-first recursive resolution for upstream nodes. This walks further
			// upstream when needed (e.g. chains of select *), then memoizes per run.
			const resolvedCols = await this._resolveColumnsForNodeRecursive(uid, memo, resolving);
			if (this._isResolvedColumns(resolvedCols)) {
				this.logger.trace(`[columns] schema mapping: ${uid} resolved recursively (${resolvedCols.length} cols)`);
				columnMap = Object.fromEntries(resolvedCols.map(c => [c.toLowerCase(), 'unknown']));
			}

			// Fall back to database_columns on raw node (list format: [{col_name, type}])
			if (!columnMap || Object.keys(columnMap).length === 0) {
				const dbCols = this._rawDatabaseColumns(raw);
				if (dbCols.length > 0) {
					this.logger.trace(`[columns] schema mapping: ${uid} using database_columns fallback (${dbCols.length} cols)`);
					columnMap = {};
					for (const col of dbCols) {
						columnMap[col.toLowerCase()] = 'unknown';
					}
				}
			}

			// Final fall back to manifest columns dict: {name: {data_type}}
			if (!columnMap || Object.keys(columnMap).length === 0) {
				const columns = raw.columns ?? {};
				if (Object.keys(columns).length > 0) {
					this.logger.trace(`[columns] schema mapping: ${uid} using manifest fallback (${Object.keys(columns).length} cols)`);
					columnMap = Object.fromEntries(
						Object.entries(columns).map(([col, info]) => [col.toLowerCase(), (info.data_type ?? 'unknown').toLowerCase()]),
					);
				}
			}

			if (!columnMap || Object.keys(columnMap).length === 0) continue;

			const insertKey = `${db}.${schema}.${table}`;
			const currentPriority = raw.resource_type === 'model' ? 2 : 1;
			const existingPriority = tablePriority.get(insertKey) ?? -1;
			if (existingPriority > currentPriority) {
				continue;
			}

			mapping[db] ??= {};
			mapping[db][schema] ??= {};
			mapping[db][schema][table] = columnMap;
			tablePriority.set(insertKey, currentPriority);
		}
		return mapping;
	}

	private async _resolveColumnsForNodeRecursive(
		uniqueId: string,
		memo: Map<string, string[]>,
		resolving: Set<string>,
	): Promise<string[]> {
		this.logger.trace(`[columns] resolve start: ${uniqueId}`);
		const memoized = memo.get(uniqueId);
		if (memoized) {
			this.logger.trace(`[columns] resolve hit memo: ${uniqueId} (${memoized.length} cols)`);
			return memoized;
		}

		const rawNode = this.indexer.getRawNode(uniqueId);
		if (!rawNode) return [];

		const cached = this.indexer.getColumns(uniqueId);
		if (cached && cached.length > 0) {
			this.logger.trace(`[columns] resolve hit cache: ${uniqueId} (${cached.length} cols)`);
			memo.set(uniqueId, cached);
			return cached;
		}

		const manifestCols = Object.keys(rawNode.columns ?? {});
		if (resolving.has(uniqueId)) {
			this.logger.trace(`[columns] resolve cycle guard: ${uniqueId} -> manifest (${manifestCols.length} cols)`);
			memo.set(uniqueId, manifestCols);
			return manifestCols;
		}
		resolving.add(uniqueId);

		try {
			if (rawNode.resource_type === 'model' && rawNode.original_file_path) {
				this.logger.trace(`[columns] resolve parse-first: ${uniqueId}`);
				const modelSql = fs.readFileSync(path.join(this.indexer.projectDir, rawNode.original_file_path), 'utf8');
				const parentIds = this.indexer.index?.parentMap.get(uniqueId) ?? [];
				this.logger.trace(`[columns] resolve ${uniqueId} parent count: ${parentIds.length}`);
				const schemaMapping = await this._buildSchemaMapping(parentIds, memo, resolving);
				const { columns } = await this._resolveOutputColumns(
					rawNode.resource_type,
					rawNode,
					modelSql,
					schemaMapping,
				);
				this.logger.trace(`[columns] resolve parse result: ${uniqueId} (${columns.length} cols${columns.includes('*') ? ', has *' : ''})`);
				if (this._isResolvedColumns(columns)) {
					this.logger.trace(`[columns] resolve winner=parse: ${uniqueId} (${columns.length} cols)`);
					this.indexer.setColumns(uniqueId, columns, 'parse');
					memo.set(uniqueId, columns);
					return columns;
				}
			}

			const describedCols = await this.describeCache.columns(uniqueId);
			if (this._isResolvedColumns(describedCols)) {
				this.logger.trace(`[columns] resolve winner=describe: ${uniqueId} (${describedCols.length} cols)`);
				memo.set(uniqueId, describedCols);
				return describedCols;
			}

			const dbCols = this._rawDatabaseColumns(rawNode);
			if (this._isResolvedColumns(dbCols)) {
				this.logger.trace(`[columns] resolve winner=database_columns: ${uniqueId} (${dbCols.length} cols)`);
				this.indexer.setColumns(uniqueId, dbCols, 'database_columns');
				memo.set(uniqueId, dbCols);
				return dbCols;
			}

			this.logger.trace(`[columns] resolve winner=manifest: ${uniqueId} (${manifestCols.length} cols)`);
			if (!this._manifestFallbackWarned.has(uniqueId)) {
				this._manifestFallbackWarned.add(uniqueId);
				this.logger.warn(`[columns] using manifest/YAML fallback for ${uniqueId} (${manifestCols.length} cols). This may be incomplete versus database/parsed columns.`);
			}
			memo.set(uniqueId, manifestCols);
			return manifestCols;
		} finally {
			resolving.delete(uniqueId);
		}
	}

	/**
	 * Resolve output columns for a resource using type-appropriate strategy.
	 * Sources/seeds: manifest columns (or database_columns when available).
	 * Models: SQL parsing via bridge.
	 * Ported from dbt-core-mcp get_column_lineage._resolve_output_columns.
	 */
	private async _resolveOutputColumns(
		resourceType: string,
		raw: ReturnType<ManifestIndexer['getRawNode']>,
		compiledCode: string,
		schemaMapping: SchemaMapping,
	): Promise<{ columns: string[]; source: string }> {
		if (raw === null || raw === undefined) return { columns: [], source: 'none' };
		type RawRecord = Record<string, unknown>;
		const r = raw as unknown as RawRecord;

		if (resourceType === 'source' || resourceType === 'seed') {
			// database_columns (list format)
			const dbCols = r['database_columns'];
			if (Array.isArray(dbCols) && dbCols.length > 0) {
				const cols = (dbCols as Array<{ col_name?: string }>)
					.filter(c => c.col_name)
					.map(c => c.col_name as string);
				if (cols.length > 0) return { columns: cols, source: 'warehouse' };
			}
			// manifest columns
			const manifestCols = Object.keys(raw.columns ?? {});
			if (manifestCols.length > 0) return { columns: manifestCols, source: 'manifest' };
			// wildcard fallback
			return { columns: ['*'], source: 'wildcard' };
		}

		// Models: SQL parsing via Pyodide
		const cols = await this._getOutputColumns(compiledCode, schemaMapping);
		return { columns: cols, source: cols.length > 0 ? 'sql' : 'none' };
	}

	/**
	 * Attempt to resolve a wildcard (*) column to a specific column name for a known table.
	 * Ported from dbt-core-mcp get_column_lineage._resolve_wildcard_column_in_table.
	 */
	private _resolveWildcardColumnInTable(tableName: string, relationLookup: Map<string, string>): string | undefined {
		const uid = relationLookup.get(GetColumnLineageTool._normalizeRelationName(tableName));
		if (!uid) return undefined;
		const raw = this.indexer.getRawNode(uid);
		if (!raw) return undefined;
		const resourceType = raw.resource_type;
		if (resourceType === 'source' || resourceType === 'seed') {
			type RawRecord = Record<string, unknown>;
			const r = raw as unknown as RawRecord;
			const dbCols = r['database_columns'];
			if (Array.isArray(dbCols) && dbCols.length > 0) {
				const first = (dbCols as Array<{ col_name?: string }>)[0];
				if (first?.col_name) return first.col_name;
			}
			const manifestCols = Object.keys(raw.columns ?? {});
			if (manifestCols.length > 0) return manifestCols[0];
		}
		return undefined;
	}

	/**
	 * Normalize relation names for matching: strip quotes/backticks, lowercase.
	 * Ported from dbt-core-mcp get_column_lineage._normalize_relation_name.
	 */
	private static _normalizeRelationName(value: string): string {
		return value.replace(/["`\[\]]/g, '').trim().toLowerCase();
	}

	/**
	 * Register a uid under all FQN variants in the lookup map.
	 * Mirrors dbt-core-mcp _add_relation_keys.
	 */
	private static _addRelationKeys(
		lookup: Map<string, string>,
		uid: string,
		db: string | undefined,
		schema: string | undefined,
		identifier: string | undefined,
		relationName?: string,
		overwrite = true,
	): void {
		const setKey = (k: string): void => {
			const key = GetColumnLineageTool._normalizeRelationName(k);
			if (overwrite || !lookup.has(key)) {
				lookup.set(key, uid);
			}
		};
		if (relationName) {
			setKey(relationName);
		}
		if (!identifier) return;
		setKey(identifier);
		if (schema) {
			setKey(`${schema}.${identifier}`);
		}
		if (db && schema) {
			setKey(`${db}.${schema}.${identifier}`);
		}
	}

	/**
	 * Build FQN → unique_id lookup for resolving lineage dependencies to dbt resources.
	 * Ported from dbt-core-mcp get_column_lineage._build_relation_lookup.
	 */
	private _buildRelationLookup(): Map<string, string> {
		const lookup = new Map<string, string>();
		const index = this.indexer.index;
		if (!index) return lookup;

		// Insert sources first (non-overwriting) and models second (overwriting)
		// so ambiguous bare relation names prefer dbt models over sources.
		for (const [uid, source] of index.sources) {
			const raw = this.indexer.getRawNode(uid);
			if (!raw) continue;
			type RawRecord = Record<string, unknown>;
			const r = raw as unknown as RawRecord;
			const db = typeof r['database'] === 'string' ? r['database'] : undefined;
			const schema = source.schema?.toLowerCase() ?? (typeof r['schema'] === 'string' ? r['schema'] : undefined);
			const identifier = (typeof r['identifier'] === 'string' ? r['identifier'] : undefined) ?? source.name;
			const relationName = typeof r['relation_name'] === 'string' ? r['relation_name'] : undefined;
			GetColumnLineageTool._addRelationKeys(lookup, uid, db, schema, identifier?.toLowerCase(), relationName, false);
			GetColumnLineageTool._addRelationKeys(
				lookup,
				uid,
				db,
				schema,
				`${source.sourceName.toLowerCase()}.${(identifier ?? source.name).toLowerCase()}`,
				undefined,
				false,
			);
		}

		for (const [uid, model] of index.models) {
			const raw = this.indexer.getRawNode(uid);
			if (!raw) continue;
			type RawRecord = Record<string, unknown>;
			const r = raw as unknown as RawRecord;
			const db = typeof r['database'] === 'string' ? r['database'] : undefined;
			const schema = model.schema ?? (typeof r['schema'] === 'string' ? r['schema'] : undefined);
			const identifier = (typeof r['alias'] === 'string' ? r['alias'] : undefined) ?? raw.name;
			const relationName = typeof r['relation_name'] === 'string' ? r['relation_name'] : undefined;
			GetColumnLineageTool._addRelationKeys(lookup, uid, db, schema, identifier?.toLowerCase(), relationName, true);
		}

		return lookup;
	}

	private _dependencyMatchesUid(dep: ColumnDependency, uid: string): boolean {
		const raw = this.indexer.getRawNode(uid);
		if (!raw) return false;

		type RawRecord = Record<string, unknown>;
		const r = raw as unknown as RawRecord;
		const depTable = dep.table.toLowerCase();
		const depSchema = dep.schema?.toLowerCase();
		const depDatabase = dep.database?.toLowerCase();

		const identifier = (
			raw.resource_type === 'source'
				? (typeof r['identifier'] === 'string' ? r['identifier'] : undefined) ?? raw.name
				: (typeof r['alias'] === 'string' ? r['alias'] : undefined) ?? raw.name
		).toLowerCase();

		if (identifier !== depTable) return false;

		const schema = (typeof r['schema'] === 'string' ? r['schema'] : undefined)?.toLowerCase();
		const database = (typeof r['database'] === 'string' ? r['database'] : undefined)?.toLowerCase();

		if (depSchema && schema !== depSchema) return false;
		if (depDatabase && database !== depDatabase) return false;

		return true;
	}

	/**
	 * Resolve a lineage dependency table name to a dbt unique_id.
	 */
	private _resolveDependency(dep: ColumnDependency, lookup: Map<string, string>, currentModelUniqueId?: string): string | undefined {
		const index = this.indexer.index;
		if (index && currentModelUniqueId) {
			const directParents = index.parentMap.get(currentModelUniqueId) ?? [];
			const parentMatches = directParents.filter(uid => this._dependencyMatchesUid(dep, uid));
			if (parentMatches.length === 1) return parentMatches[0];
			if (parentMatches.length > 1) {
				const modelMatch = parentMatches.find(uid => uid.startsWith('model.'));
				if (modelMatch) return modelMatch;
				return parentMatches[0];
			}
		}

		const table = dep.table.toLowerCase();

		if (dep.database && dep.schema) {
			const match = lookup.get(GetColumnLineageTool._normalizeRelationName(`${dep.database}.${dep.schema}.${table}`));
			if (match) return match;
		}

		if (dep.schema) {
			const match = lookup.get(GetColumnLineageTool._normalizeRelationName(`${dep.schema}.${table}`));
			if (match) return match;
		}

		return lookup.get(GetColumnLineageTool._normalizeRelationName(table));
	}

	/**
	 * Ensure a model node has compiled_code, using the shared CompileCache.
	 * Returns undefined for non-model nodes or if compilation fails.
	 */
	private async _ensureCompiled(uniqueId: string): Promise<string | undefined> {
		const raw = this.indexer.getRawNode(uniqueId);
		if (!raw) return undefined;
		if (raw.resource_type !== 'model') return undefined;
		// Fast path: compiled_code already present in the indexed manifest node.
		// Delegates to compileCache only when absent so it can serve from cache
		// or trigger a subprocess compile.
		if ('compiled_code' in raw && raw.compiled_code) return raw.compiled_code;
		return this.compileCache.ensureCompiled(
			uniqueId,
			raw.name,
			this.indexer.projectDir,
			raw.original_file_path,
		);
	}

	/**
	 * Trace column lineage for a single model+column via Pyodide.
	 */
	private async _traceColumn(
		modelUniqueId: string,
		_modelName: string,
		columnName: string,
	): Promise<LineageResult | null> {
		const raw = this.indexer.getRawNode(modelUniqueId);
		if (!raw || raw.resource_type !== 'model') return null;

		const sql = fs.readFileSync(path.join(this.indexer.projectDir, raw.original_file_path), 'utf8');

		const lineage = this.indexer.getLineage(modelUniqueId, 5, 0);
		const schemaMapping = await this._buildSchemaMapping(
			lineage.upstream.map(n => n.uniqueId),
			new Map<string, string[]>(),
			new Set<string>(),
		);

		try {
			if (!this.ftlParser.traceLineageV2) {
				this.logger.warn('Column lineage unavailable: active parser does not implement traceLineageV2');
				return null;
			}
			const schemaJson = JSON.stringify(schemaMapping);
			const result = await this.ftlParser.traceLineageV2(sql, columnName, schemaJson);
			if ('error' in result) {
				this.logger.warn(`Column lineage error for ${_modelName}.${columnName}: ${result.error}`);
				return null;
			}
			return result;
		} catch (err) {
			const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
			this.logger.warn(`Column lineage error: ${msg}`);
			return null;
		}
	}

	/**
	 * Resolve output columns for the model by parsing compiled SQL via Pyodide.
	 */
	private async _getOutputColumns(
		compiledCode: string,
		schemaMapping: SchemaMapping,
	): Promise<string[]> {
		// Flatten 4-level schema (db→schema→table→col) to 2-level (table→col) for qualify()
		const flatSchema: Record<string, Record<string, string>> = {};
		for (const schemas of Object.values(schemaMapping)) {
			for (const tables of Object.values(schemas)) {
				for (const [table, cols] of Object.entries(tables)) {
					flatSchema[table] = cols;
				}
			}
		}
		try {
			const result = await this.ftlParser.parse(compiledCode, { schema: flatSchema });
			return result.finalColumns.map(c => c.name);
		} catch {
			return [];
		}
	}

	/**
	 * Recursively trace upstream dependencies for a column.
	 * Handles wildcard (*) columns by resolving them via _resolveWildcardColumnInTable.
	 */
	private async _traceUpstreamRecursive(
		modelUniqueId: string,
		modelName: string,
		columnName: string,
		maxDepth: number,
		currentDepth: number,
		relationLookup: Map<string, string>,
		visited: Set<string>,
		columnEdges: Array<{ sourceModel: string; sourceColumn: string; targetModel: string; targetColumn: string }>,
	): Promise<ColumnDependency[]> {
		if (currentDepth >= maxDepth) {
			this.logger.info(`[lineage] depth limit reached at depth=${currentDepth} for ${modelName}.${columnName}`);
			return [];
		}
		if (columnName === '*') return [];

		const visitKey = `${modelUniqueId}.${columnName}`;
		if (visited.has(visitKey)) {
			this.logger.trace(`[lineage] already visited ${visitKey}, skipping`);
			return [];
		}
		visited.add(visitKey);

		this.logger.info(`[lineage] depth=${currentDepth} tracing ${modelName}.${columnName} (${modelUniqueId})`);

		const lineageResult = await this._traceColumn(modelUniqueId, modelName, columnName);
		if (!lineageResult) {
			this.logger.warn(`[lineage] _traceColumn returned null for ${modelName}.${columnName} — parser returned no result`);
			return [];
		}

		this.logger.info(`[lineage] bridge returned ${lineageResult.dependencies.length} deps for ${modelName}.${columnName}: ${lineageResult.dependencies.map(d => `${d.table}.${d.column}`).join(', ') || '(none)'}`);

		const allDeps: ColumnDependency[] = [];

		for (const dep of lineageResult.dependencies) {
			const resolvedId = this._resolveDependency(dep, relationLookup, modelUniqueId);
			if (resolvedId) {
				dep.dbt_resource = resolvedId;
				this.logger.trace(`[lineage] resolved ${dep.table} → ${resolvedId}`);
			} else {
				this.logger.warn(`[lineage] could not resolve table "${dep.table}" to a dbt resource (schema=${dep.schema}, db=${dep.database})`);
			}

			// Try to resolve wildcard column before recursing
			let effectiveColumn = dep.column;
			if (effectiveColumn === '*') {
				const resolved = this._resolveWildcardColumnInTable(dep.table, relationLookup);
				if (resolved) {
					effectiveColumn = resolved;
					dep.column = resolved;
				} else {
					// select * is a passthrough — the column name we are tracing is preserved
					effectiveColumn = columnName;
					dep.column = columnName;
				}
			}

			allDeps.push(dep);

			// Record column-level edge and recurse into upstream model dependencies
			if (resolvedId && effectiveColumn && effectiveColumn !== '*') {
				columnEdges.push({
					sourceModel: resolvedId,
					sourceColumn: effectiveColumn,
					targetModel: modelUniqueId,
					targetColumn: columnName,
				});
				const node = this.indexer.getRawNode(resolvedId);
				if (node && node.resource_type === 'model') {
					this.logger.info(`[lineage] recursing into model ${node.name}.${effectiveColumn} at depth=${currentDepth + 1}`);
					const deeper = await this._traceUpstreamRecursive(
						resolvedId,
						node.name,
						effectiveColumn,
						maxDepth,
						currentDepth + 1,
						relationLookup,
						visited,
						columnEdges,
					);
					allDeps.push(...deeper);
				} else if (node) {
					this.logger.info(`[lineage] stopping at ${resolvedId} — resource_type=${node.resource_type} (terminal node)`);
				}
			}
		}

		return allDeps;
	}

	/**
	 * Enrich model-type dependencies with their internal CTE transformations.
	 * Ported from dbt-core-mcp get_column_lineage._trace_upstream_recursive enrichment block.
	 */
	private async _enrichDependencyTransformations(
		dependencies: ColumnDependency[],
	): Promise<void> {
		const cache = new Map<string, Pick<ColumnDependency, 'transformations' | 'via_ctes'>>();
		for (const dep of dependencies) {
			if (!dep.dbt_resource || !dep.column || dep.column === '*') continue;
			const raw = this.indexer.getRawNode(dep.dbt_resource);
			if (!raw || raw.resource_type !== 'model') continue;
			const key = `${dep.dbt_resource}::${dep.column}`;
			if (cache.has(key)) {
				const cached = cache.get(key)!;
				if (cached.transformations) dep.transformations = cached.transformations;
				if (cached.via_ctes) dep.via_ctes = cached.via_ctes;
				continue;
			}
			try {
				const result = await this._traceColumn(dep.dbt_resource, raw.name, dep.column);
				if (result && result.transformations.length > 0) {
					dep.transformations = result.transformations;
					dep.via_ctes = result.transformations
						.filter(t => t.type === 'cte' && t.id.startsWith('cte:'))
						.map(t => t.id.slice(4));
				}
			} catch {
				// Keep dep without internal transforms on failure
			}
			cache.set(key, { transformations: dep.transformations, via_ctes: dep.via_ctes });
		}
	}

	/**
	 * Format the lineage response in the standard structure.
	 * Derives via_ctes from the new namespaced transformation format.
	 * Ported from dbt-core-mcp get_column_lineage._format_lineage_response.
	 */
	private _formatLineageResponse(
		modelName: string,
		uniqueId: string,
		column: string,
		direction: string,
		dependencies: ColumnDependency[],
		rootLineage: LineageResult | null,
	): Record<string, unknown> {
		const base = { model: modelName, unique_id: uniqueId, column, direction };

		if (direction === 'downstream') {
			return { ...base, usages: [], note: 'Downstream column lineage not yet implemented' };
		}

		const transformations = rootLineage?.transformations ?? [];

		// Derive via_ctes from new namespaced format (cte:name → name)
		const viaCtes: string[] = [];
		for (const t of transformations) {
			if (t.type === 'cte' && t.id.startsWith('cte:')) {
				const name = t.id.slice(4);
				if (!viaCtes.includes(name)) viaCtes.push(name);
			}
		}

		return {
			...base,
			transformations,
			via_ctes: viaCtes.length > 0 ? viaCtes : (rootLineage?.via_ctes ?? []),
			dependencies,
			dependency_count: dependencies.length,
		};
	}

	/**
	 * Resolve the output columns for a node by parsing its compiled SQL.
	 * Falls back to manifest columns if compiled SQL is unavailable.
	 */
	async resolveColumnsForNode(uniqueId: string): Promise<string[]> {
		return this._resolveColumnsForNodeRecursive(uniqueId, new Map<string, string[]>(), new Set<string>());
	}

	/**
	 * Trace column lineage directly, returning structured data.
	 * Used by both the LM tool invoke() and the lineage graph webview.
	 */
	private static readonly _emptyColumnEdges: Array<{ sourceModel: string; sourceColumn: string; targetModel: string; targetColumn: string }> = [];

	async traceColumnDirect(
		uniqueId: string,
		column: string,
		direction: 'upstream' | 'downstream' | 'both' = 'upstream',
		depth?: number,
	): Promise<{ error?: string; dependencies: ColumnDependency[]; columnEdges: Array<{ sourceModel: string; sourceColumn: string; targetModel: string; targetColumn: string }> }> {
		const rawNode = this.indexer.getRawNode(uniqueId);
		if (!rawNode) {
			return { error: `Raw manifest data not found for "${uniqueId}"`, dependencies: [], columnEdges: GetColumnLineageTool._emptyColumnEdges };
		}

		// Sources, seeds, snapshots are terminal nodes — no upstream to trace
		if (rawNode.resource_type !== 'model') {
			return { dependencies: [], columnEdges: GetColumnLineageTool._emptyColumnEdges };
		}

		const rawSql = fs.readFileSync(path.join(this.indexer.projectDir, rawNode.original_file_path), 'utf8');

		const upstreamLineage = this.indexer.getLineage(uniqueId, 5, 0);
		const schemaMapping = await this._buildSchemaMapping(
			upstreamLineage.upstream.map(n => n.uniqueId),
			new Map<string, string[]>(),
			new Set<string>(),
		);
		const { columns: outputColumns } = await this._resolveOutputColumns(
			rawNode.resource_type,
			rawNode,
			rawSql,
			schemaMapping,
		);

		if (outputColumns.length > 0 && !outputColumns.includes('*') && !outputColumns.includes(column)) {
			return { error: `Column "${column}" not found in output of model "${rawNode.name}". Available columns: ${outputColumns.join(', ')}`, dependencies: [], columnEdges: GetColumnLineageTool._emptyColumnEdges };
		}

		if (direction === 'downstream') {
			return { dependencies: [], columnEdges: GetColumnLineageTool._emptyColumnEdges };
		}

		const maxDepth = depth ?? 10;
		const relationLookup = this._buildRelationLookup();
		const visited = new Set<string>();
		const columnEdges: Array<{ sourceModel: string; sourceColumn: string; targetModel: string; targetColumn: string }> = [];

		const dependencies = await this._traceUpstreamRecursive(
			uniqueId,
			rawNode.name,
			column,
			maxDepth,
			0,
			relationLookup,
			visited,
			columnEdges,
		);

		await this._enrichDependencyTransformations(dependencies);
		return { dependencies, columnEdges };
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetColumnLineageInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { model, column, direction = 'upstream', depth } = options.input;
		this.logger.info(`LM Tool: getColumnLineage model="${model}" column="${column}" direction="${direction}"`);

		const models = this.indexer.findModelsByName(model);
		if (models.length === 0) {
			return toolResult({ error: `Model "${model}" not found in manifest` });
		}

		const modelInfo = models[0];
		const rawNode = this.indexer.getRawNode(modelInfo.uniqueId);
		if (!rawNode) {
			return toolResult({ error: `Raw manifest data not found for "${model}"` });
		}

		const traced = await this.traceColumnDirect(modelInfo.uniqueId, column, direction, depth);
		if (traced.error) {
			return toolResult({ error: traced.error });
		}

		if (direction === 'upstream' || direction === 'both') {
			const rootLineage = await this._traceColumn(modelInfo.uniqueId, modelInfo.name, column);
			return toolResult(this._formatLineageResponse(
				modelInfo.name,
				modelInfo.uniqueId,
				column,
				direction,
				traced.dependencies,
				rootLineage,
			));
		}

		// Downstream-only
		return toolResult(this._formatLineageResponse(
			modelInfo.name,
			modelInfo.uniqueId,
			column,
			'downstream',
			[],
			null,
		));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetColumnLineageInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Tracing column lineage for: ${options.input.model}.${options.input.column}...` };
	}
}

