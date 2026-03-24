import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { toolResult } from './tool-helpers';

interface AnalyzeImpactInput {
	name: string;
	resource_type?: string;
}

export class AnalyzeImpactTool implements vscode.LanguageModelTool<AnalyzeImpactInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AnalyzeImpactInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { name, resource_type } = options.input;
		this.logger.info(`LM Tool: analyzeImpact name="${name}"`);

		const resources = this.indexer.findResource(name, resource_type);
		if (resources.length === 0) {
			return toolResult({ error: `Resource "${name}" not found in manifest` });
		}

		const target = resources[0];
		const lineage = this.indexer.getLineage(target.uniqueId, 100, 'downstream');

		const downstream = lineage.downstream.map(uid => {
			const m = this.indexer.index?.models.get(uid);
			if (m) {
				return {
					unique_id: uid,
					name: m.name,
					type: 'model',
					materialization: m.materialisation,
				};
			}
			const s = this.indexer.index?.sources.get(uid);
			if (s) {
				return { unique_id: uid, name: s.name, type: 'source' };
			}
			return { unique_id: uid, name: uid.split('.').pop() ?? uid, type: 'unknown' };
		});

		return toolResult({
			name: target.name,
			unique_id: target.uniqueId,
			resource_type: target.type,
			impacted_count: downstream.length,
			impacted_resources: downstream,
			recommendation: downstream.length > 0
				? `Run affected models: dbt run -s ${target.name}+`
				: 'No downstream dependencies affected.',
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AnalyzeImpactInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Analyzing impact of changes to: ${options.input.name}...` };
	}
}
