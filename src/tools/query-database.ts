import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { DatabaseProvider } from '../providers/database/database-provider';
import type { DbtQueryService } from '../services/dbt-query-service';
import { toolResult } from './tool-helpers';

interface QueryDatabaseInput {
	sql: string;
	cte_name?: string;
	model_name?: string;
}

export class QueryDatabaseTool implements vscode.LanguageModelTool<QueryDatabaseInput> {
	constructor(
		private readonly provider: DatabaseProvider,
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly dbtQueryService: DbtQueryService,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<QueryDatabaseInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		let { sql } = options.input;
		const { cte_name, model_name } = options.input;
		this.logger.info('LM Tool: queryDatabase');

		// CTE extraction: compile the model and parse to find the CTE boundary
		if (cte_name && model_name) {
			const resources = this.indexer.findResource(model_name, 'model');
			if (resources.length === 0) {
				return toolResult({ error: `Model "${model_name}" not found in manifest` });
			}
			const cteSql = await this.dbtQueryService.buildCteSql(resources[0].uniqueId, cte_name);
			if (!cteSql) {
				return toolResult({ error: `CTE "${cte_name}" not found in model "${model_name}"` });
			}
			sql = cteSql;
		}

		try {
			const result = await this.provider.query(sql, -1);
			return toolResult({ success: true, row_count: result.rowCount, rows: result.rows });
		} catch (err) {
			return toolResult({ error: String(err) });
		}
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<QueryDatabaseInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Querying database via ${this.provider.adapterType}...` };
	}
}
