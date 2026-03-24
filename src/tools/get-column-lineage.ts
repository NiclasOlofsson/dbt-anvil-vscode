import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { toolResult } from './tool-helpers';

interface GetColumnLineageInput {
	model: string;
	column?: string;
}

export class GetColumnLineageTool implements vscode.LanguageModelTool<GetColumnLineageInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

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
			note: 'Column-level lineage from manifest metadata. For full SQL-level column lineage, use the dbt-core-mcp server.',
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
