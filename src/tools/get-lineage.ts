import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { toolResult } from './tool-helpers';

interface GetLineageInput {
	name: string;
	resource_type?: string;
	direction?: 'both' | 'upstream' | 'downstream';
	depth?: number;
}

export class GetLineageTool implements vscode.LanguageModelTool<GetLineageInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetLineageInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { name, resource_type, direction = 'both', depth } = options.input;
		this.logger.info(`LM Tool: getLineage name="${name}" direction=${direction} depth=${depth ?? 'all'}`);

		const resources = this.indexer.findResource(name, resource_type);
		if (resources.length === 0) {
			return toolResult({ error: `Resource "${name}" not found in manifest` });
		}

		const target = resources[0];
		const lineage = this.indexer.getLineage(target.uniqueId, depth, direction);

		return toolResult({
			name: target.name,
			unique_id: target.uniqueId,
			resource_type: target.type,
			direction,
			upstream: lineage.upstream,
			downstream: lineage.downstream,
			upstream_count: lineage.upstream.length,
			downstream_count: lineage.downstream.length,
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetLineageInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Getting lineage for: ${options.input.name}...` };
	}
}
