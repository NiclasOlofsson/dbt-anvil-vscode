import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult } from './tool-helpers';

interface GetColumnLineageInput {
	model: string;
	column: string;
	direction?: 'upstream' | 'downstream' | 'both';
	depth?: number;
}

// Schema mapping shape sent to the bridge: {database: {schema: {table: {col: type}}}}
type SchemaMapping = Record<string, Record<string, Record<string, Record<string, string>>>>;

interface ColumnDependency {
	column: string;
	table: string;
	schema?: string;
	database?: string;
	dbt_resource?: string;
}

interface Transformation {
	cte: string;
	column: string;
	expression?: string;
}

interface LineageResult {
	dependencies: ColumnDependency[];
	via_ctes: string[];
	transformations: Transformation[];
}

export class GetColumnLineageTool implements vscode.LanguageModelTool<GetColumnLineageInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
	) {}

	/**
	 * Build sqlglot schema mapping from upstream nodes.
	 * Format: {database: {schema: {table: {column: type}}}}
	 */
	private _buildSchemaMapping(upstreamIds: string[]): SchemaMapping {
		const mapping: SchemaMapping = {};
		for (const uid of upstreamIds) {
			const raw = this.indexer.getRawNode(uid);
			if (!raw) continue;

			const columns = raw.columns ?? {};
			if (Object.keys(columns).length === 0) continue;

			const db = ('database' in raw ? raw.database : undefined) ?? '__default__';
			const schema = ('schema' in raw ? raw.schema : undefined) ?? '__default__';
			const table = raw.name.toLowerCase();

			mapping[db] ??= {};
			mapping[db][schema] ??= {};
			mapping[db][schema][table] = Object.fromEntries(
				Object.entries(columns).map(([col, info]) => [col, info.data_type ?? 'unknown']),
			);
		}
		return mapping;
	}

	/**
	 * Build FQN → unique_id lookup for resolving lineage dependencies to dbt resources.
	 */
	private _buildRelationLookup(): Map<string, string> {
		const lookup = new Map<string, string>();
		const index = this.indexer.index;
		if (!index) return lookup;

		for (const [uid, model] of index.models) {
			const raw = this.indexer.getRawNode(uid);
			if (!raw) continue;

			const db = ('database' in raw ? raw.database : undefined);
			const schema = model.schema ?? ('schema' in raw ? raw.schema : undefined);
			const name = raw.name.toLowerCase();

			// Register at multiple keys for flexible matching
			lookup.set(name, uid);
			if (schema) {
				lookup.set(`${schema}.${name}`.toLowerCase(), uid);
			}
			if (db && schema) {
				lookup.set(`${db}.${schema}.${name}`.toLowerCase(), uid);
			}
		}

		// Also register sources
		for (const [uid, source] of index.sources) {
			const raw = this.indexer.getRawNode(uid);
			if (!raw) continue;

			const name = source.name.toLowerCase();
			const schema = source.schema?.toLowerCase();

			lookup.set(name, uid);
			if (schema) {
				lookup.set(`${schema}.${name}`, uid);
			}
		}

		return lookup;
	}

	/**
	 * Resolve a lineage dependency table name to a dbt unique_id.
	 */
	private _resolveDependency(dep: ColumnDependency, lookup: Map<string, string>): string | undefined {
		const table = dep.table.toLowerCase();

		if (dep.database && dep.schema) {
			const key = `${dep.database}.${dep.schema}.${table}`.toLowerCase();
			const match = lookup.get(key);
			if (match) return match;
		}

		if (dep.schema) {
			const key = `${dep.schema}.${table}`.toLowerCase();
			const match = lookup.get(key);
			if (match) return match;
		}

		return lookup.get(table);
	}

	/**
	 * Trace column lineage for a single model+column via the bridge.
	 */
	private async _traceColumn(
		modelUniqueId: string,
		modelName: string,
		columnName: string,
		dialect: string,
	): Promise<LineageResult | null> {
		const raw = this.indexer.getRawNode(modelUniqueId);
		if (!raw) return null;

		const compiledCode = 'compiled_code' in raw ? raw.compiled_code : undefined;
		if (!compiledCode) return null;

		const lineage = this.indexer.getLineage(modelUniqueId, 5, 'upstream');
		const schemaMapping = this._buildSchemaMapping(lineage.upstream);

		try {
			const result = await this.service.submit({
				type: 'column_lineage',
				raw: {
					get_column_lineage: true,
					compiled_sql: compiledCode,
					column_name: columnName,
					dialect,
					schema_mapping: schemaMapping,
				},
				priority: Priority.Tool,
				origin: 'copilot',
				label: `column lineage for ${modelName}.${columnName}`,
			});

			const data = result.data as Record<string, unknown> | undefined;
			if (!data || !data['success']) {
				this.logger.warn(`Column lineage bridge call failed: ${data?.['error'] ?? 'unknown error'}`);
				return null;
			}

			return {
				dependencies: (data['dependencies'] as ColumnDependency[]) ?? [],
				via_ctes: (data['via_ctes'] as string[]) ?? [],
				transformations: (data['transformations'] as Transformation[]) ?? [],
			};
		} catch (err) {
			this.logger.warn(`Column lineage bridge error: ${err}`);
			return null;
		}
	}

	/**
	 * Resolve output columns for the model by calling get_columns on the bridge.
	 */
	private async _getOutputColumns(
		compiledCode: string,
		dialect: string,
		schemaMapping: SchemaMapping,
	): Promise<string[]> {
		try {
			const result = await this.service.submit({
				type: 'get_columns',
				raw: {
					get_columns: true,
					compiled_sql: compiledCode,
					dialect,
					schema_mapping: schemaMapping,
				},
				priority: Priority.Tool,
				origin: 'copilot',
				label: 'resolve output columns',
			});

			const data = result.data as Record<string, unknown> | undefined;
			const cols = data && Array.isArray(data['columns']) ? data['columns'] as string[] : [];
			return cols;
		} catch {
			return [];
		}
	}

	/**
	 * Recursively trace upstream dependencies for a column.
	 */
	private async _traceUpstreamRecursive(
		modelUniqueId: string,
		modelName: string,
		columnName: string,
		dialect: string,
		maxDepth: number,
		currentDepth: number,
		relationLookup: Map<string, string>,
		visited: Set<string>,
	): Promise<ColumnDependency[]> {
		if (currentDepth >= maxDepth) return [];
		if (columnName === '*') return [];

		const visitKey = `${modelUniqueId}.${columnName}`;
		if (visited.has(visitKey)) return [];
		visited.add(visitKey);

		const lineageResult = await this._traceColumn(modelUniqueId, modelName, columnName, dialect);
		if (!lineageResult) return [];

		const allDeps: ColumnDependency[] = [];

		for (const dep of lineageResult.dependencies) {
			const resolvedId = this._resolveDependency(dep, relationLookup);
			if (resolvedId) {
				dep.dbt_resource = resolvedId;
			}
			allDeps.push(dep);

			// Recurse into upstream model dependencies
			if (resolvedId && dep.column) {
				const node = this.indexer.getRawNode(resolvedId);
				if (node && node.resource_type === 'model') {
					const deeper = await this._traceUpstreamRecursive(
						resolvedId,
						node.name,
						dep.column,
						dialect,
						maxDepth,
						currentDepth + 1,
						relationLookup,
						visited,
					);
					allDeps.push(...deeper);
				}
			}
		}

		return allDeps;
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

		const compiledCode = 'compiled_code' in rawNode ? rawNode.compiled_code : undefined;
		if (!compiledCode) {
			return toolResult({ error: `No compiled SQL found for "${model}". Run "dbt compile" first.` });
		}

		const index = this.indexer.index;
		const dialect = index?.adapterType ?? 'ansi';

		// Validate that the requested column exists in the output
		const upstreamLineage = this.indexer.getLineage(modelInfo.uniqueId, 5, 'upstream');
		const schemaMapping = this._buildSchemaMapping(upstreamLineage.upstream);
		const outputColumns = await this._getOutputColumns(compiledCode, dialect, schemaMapping);

		if (outputColumns.length > 0 && !outputColumns.includes(column)) {
			return toolResult({
				error: `Column "${column}" not found in output of model "${model}". Available columns: ${outputColumns.join(', ')}`,
			});
		}

		const maxDepth = depth ?? 10;
		const relationLookup = this._buildRelationLookup();
		const visited = new Set<string>();

		if (direction === 'upstream' || direction === 'both') {
			const dependencies = await this._traceUpstreamRecursive(
				modelInfo.uniqueId,
				modelInfo.name,
				column,
				dialect,
				maxDepth,
				0,
				relationLookup,
				visited,
			);

			// Get the root model's lineage for CTE paths and transformations
			const rootLineage = await this._traceColumn(modelInfo.uniqueId, modelInfo.name, column, dialect);

			return toolResult({
				model: modelInfo.name,
				unique_id: modelInfo.uniqueId,
				column,
				direction,
				via_ctes: rootLineage?.via_ctes ?? [],
				transformations: rootLineage?.transformations ?? [],
				dependencies,
				dependency_count: dependencies.length,
			});
		}

		// Downstream-only (future expansion)
		return toolResult({
			model: modelInfo.name,
			unique_id: modelInfo.uniqueId,
			column,
			direction,
			dependencies: [],
			dependency_count: 0,
			note: 'Downstream column lineage not yet implemented',
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetColumnLineageInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Tracing column lineage for: ${options.input.model}.${options.input.column}...` };
	}
}

