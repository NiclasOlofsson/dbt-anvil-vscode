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

		const affected = lineage.downstream.map(node => ({
			unique_id: node.uniqueId,
			name: node.name,
			type: node.type,
			distance: node.distance,
		}));

		const modelsAffected = affected.filter(n => n.type === 'model');
		const testsAffected = affected.filter(n => n.type === 'test');
		const otherAffected = affected.filter(n => n.type !== 'model' && n.type !== 'test');

		// Group by distance
		const affectedByDistance: Record<string, typeof affected> = {};
		for (const node of affected) {
			const key = String(node.distance);
			affectedByDistance[key] ??= [];
			affectedByDistance[key].push(node);
		}

		const modelCount = modelsAffected.length;
		const impactLevel = modelCount <= 3 ? 'Low' : modelCount <= 10 ? 'Medium' : 'High';
		const message = `${impactLevel} impact (${modelCount} model${modelCount === 1 ? '' : 's'} affected)`;

		const resourceType = target.type;
		let recommendation: string;
		if (resourceType === 'source') {
			recommendation = `Run dbt test -s source:${target.name}+ to validate source data`;
		} else if (resourceType === 'seed') {
			recommendation = `Run dbt seed -s ${target.name} && dbt run -s ${target.name}+ to rebuild`;
		} else {
			recommendation = `Run dbt run -s ${target.name}+ to rebuild all impacted models`;
		}

		return toolResult({
			resource: {
				name: target.name,
				unique_id: target.uniqueId,
				resource_type: target.type,
			},
			impact: {
				models_affected: modelsAffected,
				models_affected_count: modelsAffected.length,
				tests_affected_count: testsAffected.length,
				other_affected_count: otherAffected.length,
				total_affected: affected.length,
			},
			affected_by_distance: affectedByDistance,
			recommendation,
			message,
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<AnalyzeImpactInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Analyzing impact of changes to: ${options.input.name}...` };
	}
}
