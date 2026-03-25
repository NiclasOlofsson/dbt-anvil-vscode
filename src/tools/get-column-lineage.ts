import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult } from './tool-helpers';

interface GetColumnLineageInput {
	model: string;
	column?: string;
}

// Schema mapping shape sent to the bridge: {database: {schema: {table: {col: {}}}}}
type SchemaMapping = Record<string, Record<string, Record<string, Record<string, object>>>>;

export class GetColumnLineageTool implements vscode.LanguageModelTool<GetColumnLineageInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
	) {}

	private _buildSchemaMapping(upstreamIds: string[]): SchemaMapping {
		const mapping: SchemaMapping = {};
		for (const uid of upstreamIds) {
			const raw = this.indexer.getRawNode(uid);
			if (!raw || !raw.columns || Object.keys(raw.columns).length === 0) continue;

			const db = raw.database ?? '__default__';
			const schema = raw.schema ?? '__default__';
			const table = raw.name.toLowerCase();

			mapping[db] ??= {};
			mapping[db][schema] ??= {};
			mapping[db][schema][table] = Object.fromEntries(
				Object.keys(raw.columns).map(col => [col, {}]),
			);
		}
		return mapping;
	}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetColumnLineageInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { model, column } = options.input;
		this.logger.info(`LM Tool: getColumnLineage model="${model}" column="${column ?? 'all'}"`);

		const models = this.indexer.findModelsByName(model);
		if (models.length === 0) {
			return toolResult({ error: `Model "${model}" not found in manifest` });
		}

		const rawNode = this.indexer.getRawNode(models[0].uniqueId);
		if (!rawNode) {
			return toolResult({ error: `Raw manifest data not found for "${model}"` });
		}

		// Attempt SQL-level column resolution via the bridge
		const compiledCode = 'compiled_code' in rawNode ? rawNode.compiled_code : undefined;
		if (compiledCode) {
			try {
				const index = this.indexer.index;
				const adapterType = index?.adapterType ?? 'ansi';
				const lineage = this.indexer.getLineage(models[0].uniqueId, 5, 'upstream');
				const schemaMapping = this._buildSchemaMapping(lineage.upstream);

				const result = await this.service.submit({
					type: 'get_columns',
					raw: {
						get_columns: true,
						compiled_sql: compiledCode,
						dialect: adapterType,
						schema_mapping: schemaMapping,
					},
					priority: Priority.Tool,
					origin: 'copilot',
					label: `get columns for ${model}`,
				});

				const cols = result.data && Array.isArray((result.data as Record<string, unknown>)['columns'])
					? (result.data as Record<string, unknown>)['columns'] as string[]
					: null;

				if (cols && cols.length > 0) {
					const filtered = column ? cols.filter(c => c === column) : cols;
					return toolResult({
						model: models[0].name,
						unique_id: models[0].uniqueId,
						columns: filtered.map(name => ({ name })),
						source: 'compiled_sql',
					});
				}
			} catch (err) {
				this.logger.warn(`getColumnLineage bridge call failed: ${err}`);
			}
		}

		// Fallback: manifest column metadata
		const columns = rawNode.columns ?? {};
		const filteredColumns = column
			? Object.fromEntries(Object.entries(columns).filter(([k]) => k === column))
			: columns;

		return toolResult({
			model: models[0].name,
			unique_id: models[0].uniqueId,
			columns: Object.entries(filteredColumns).map(([name, info]) => ({
				name,
				data_type: info.data_type,
				description: info.description,
			})),
			source: 'manifest',
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetColumnLineageInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const col = options.input.column ? ` column="${options.input.column}"` : '';
		return { invocationMessage: `Getting column lineage for: ${options.input.model}${col}...` };
	}
}

