import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { toolResult, formatBridgeResult } from './tool-helpers';
import { extractCteSql } from './cte-extractor';

interface QueryDatabaseInput {
	sql: string;
	cte_name?: string;
	model_name?: string;
}

export class QueryDatabaseTool implements vscode.LanguageModelTool<QueryDatabaseInput> {
	constructor(
		private readonly bridge: BridgeRunner,
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<QueryDatabaseInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		let { sql } = options.input;
		const { cte_name, model_name } = options.input;
		this.logger.info('LM Tool: queryDatabase');

		// CTE extraction: extract SQL for a specific CTE from a model
		if (cte_name && model_name) {
			const resources = this.indexer.findResource(model_name, 'model');
			if (resources.length === 0) {
				return toolResult({ error: `Model "${model_name}" not found in manifest` });
			}
			const rawNode = this.indexer.getRawNode(resources[0].uniqueId);
			const rawSql = rawNode && 'raw_code' in rawNode ? rawNode.raw_code : undefined;
			if (!rawSql) {
				return toolResult({ error: `No SQL found for model "${model_name}"` });
			}
			const extracted = extractCteSql(rawSql, cte_name);
			if (!extracted) {
				return toolResult({ error: `CTE "${cte_name}" not found in model "${model_name}"` });
			}
			sql = extracted;
		}

		const args = ['show', '--inline', sql];
		const result = await this.bridge.invoke(args);
		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<QueryDatabaseInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Querying database via dbt show...' };
	}
}
