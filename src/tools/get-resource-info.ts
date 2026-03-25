import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { toolResult } from './tool-helpers';

interface GetResourceInfoInput {
	name: string;
	resource_type?: string;
	include_compiled_sql?: boolean;
}

export class GetResourceInfoTool implements vscode.LanguageModelTool<GetResourceInfoInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly service: DbtExecutionService,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetResourceInfoInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { name, resource_type, include_compiled_sql = true } = options.input;
		this.logger.info(`LM Tool: getResourceInfo name="${name}" include_compiled_sql=${include_compiled_sql}`);

		// Find the resource
		const resources = this.indexer.findResource(name, resource_type);
		let rawNode;

		if (resources.length > 0) {
			rawNode = this.indexer.getRawNode(resources[0].uniqueId);
		} else {
			// Fall back to direct unique_id lookup
			rawNode = this.indexer.getRawNode(name);
		}

		if (!rawNode) {
			return toolResult({ error: `Resource "${name}" not found in manifest` });
		}

		// If compiled SQL is requested but missing, trigger a compile
		const hasCompiledSql = 'compiled_code' in rawNode && rawNode.compiled_code;
		if (include_compiled_sql && !hasCompiledSql && rawNode.resource_type === 'model') {
			try {
				const compileResult = await this.service.submit({
					type: 'compile',
					args: ['compile', '-s', rawNode.name],
					priority: Priority.Tool,
					origin: 'copilot',
					label: `compile ${rawNode.name}`,
				});
				if (compileResult.success) {
					const reloaded = this.indexer.getRawNode(rawNode.unique_id);
					if (reloaded) {
						rawNode = reloaded;
					}
				}
			} catch {
				this.logger.warn('Failed to compile model for resource info');
			}
		}

		const columns = rawNode.columns ?? {};
		return toolResult({
			unique_id: rawNode.unique_id,
			name: rawNode.name,
			resource_type: rawNode.resource_type,
			package_name: rawNode.package_name,
			path: rawNode.original_file_path,
			description: rawNode.description,
			columns: Object.entries(columns).map(([colName, info]) => ({
				name: colName,
				data_type: info.data_type,
				description: info.description,
			})),
			tags: rawNode.tags,
			...('schema' in rawNode ? { schema: rawNode.schema } : {}),
			...('database' in rawNode ? { database: rawNode.database } : {}),
			...('compiled_code' in rawNode && rawNode.compiled_code && include_compiled_sql
				? { compiled_sql: rawNode.compiled_code }
				: {}),
			...('raw_code' in rawNode && rawNode.raw_code
				? { raw_sql: rawNode.raw_code }
				: {}),
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetResourceInfoInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Getting info for: ${options.input.name}...` };
	}
}
