import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { CompileCache } from '../dbt/compile-cache';
import { toolResult, formatBridgeResult } from './tool-helpers';

interface CompileModelInput {
	model: string;
}

export class CompileModelTool implements vscode.LanguageModelTool<CompileModelInput> {
	constructor(
		private readonly service: DbtExecutionService,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
		private readonly indexer: ManifestIndexer,
		private readonly compileCache: CompileCache,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CompileModelInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { model } = options.input;
		this.logger.info(`LM Tool: compileModel model="${model}"`);

		// Look up the unique_id so we can use the shared compile cache
		const resources = this.indexer.findResource(model, 'model');
		const raw = resources.length > 0 ? this.indexer.getRawNode(resources[0].uniqueId) : undefined;

		if (raw && raw.resource_type === 'model') {
			const compiledSql = await this.compileCache.ensureCompiled(
				raw.unique_id,
				raw.name,
				this.indexer.projectDir,
				raw.original_file_path,
			);
			if (compiledSql) {
				return toolResult({ success: true, model, compiled_sql: compiledSql });
			}
		}

		// Fallback: run compile directly and show raw dbt output (includes error messages)
		const result = await this.service.submit({
			type: 'compile',
			args: ['compile', '-s', model],
			priority: Priority.Tool,
			origin: 'copilot',
			label: `compile ${model}`,
		});

		if (result.success) {
			try {
				const { manifest } = this.loader.load(true);
				for (const node of Object.values(manifest.nodes)) {
					if (node.name === model && node.compiled_code) {
						return toolResult({ success: true, model, compiled_sql: node.compiled_code });
					}
				}
			} catch {
				// Fall through to raw output
			}
		}

		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CompileModelInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Compiling dbt model: ${options.input.model}...` };
	}
}
