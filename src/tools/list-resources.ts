import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { toolResult } from './tool-helpers';

interface ListResourcesInput {
	select?: string;
	resource_type?: string;
}

export class ListResourcesTool implements vscode.LanguageModelTool<ListResourcesInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ListResourcesInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { resource_type } = options.input;
		this.logger.info(`LM Tool: listResources type="${resource_type ?? 'all'}"`);

		const index = this.indexer.index;
		if (!index) {
			return toolResult({ error: 'Manifest index not built. Run dbt parse first.' });
		}

		const resources: Array<Record<string, unknown>> = [];

		if (!resource_type || resource_type === 'model') {
			for (const model of index.models.values()) {
				resources.push({
					unique_id: model.uniqueId,
					name: model.name,
					resource_type: 'model',
					package_name: model.packageName,
					path: model.path,
					materialization: model.materialisation,
					database: model.database,
					schema: model.schema,
					alias: model.alias,
					relation_name: model.relationName,
					tags: model.tags,
					description: model.description,
				});
			}
		}

		if (!resource_type || resource_type === 'source') {
			for (const source of index.sources.values()) {
				resources.push({
					unique_id: source.uniqueId,
					name: source.name,
					resource_type: 'source',
					source_name: source.sourceName,
					database: source.database,
					schema: source.schema,
					identifier: source.identifier,
					relation_name: source.relationName,
					tags: source.tags,
					description: source.description,
				});
			}
		}

		return toolResult({
			count: resources.length,
			...(resource_type ? { resource_type } : {}),
			resources,
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<ListResourcesInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const type = options.input.resource_type ? ` (${options.input.resource_type})` : '';
		return { invocationMessage: `Listing dbt resources${type}...` };
	}
}
