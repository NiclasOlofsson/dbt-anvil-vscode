import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult, formatBridgeResult } from './tool-helpers';

interface GetProjectInfoInput {
	run_debug?: boolean;
}

export class GetProjectInfoTool implements vscode.LanguageModelTool<GetProjectInfoInput> {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly service: DbtExecutionService,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetProjectInfoInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { run_debug = true } = options.input;
		this.logger.info(`LM Tool: getProjectInfo run_debug=${run_debug}`);

		const index = this.indexer.index;
		if (!index) {
			return toolResult({ error: 'Manifest index not built. Run dbt parse first.' });
		}

		const dbtVersion = this.loader.getDbtVersion();

		const info: Record<string, unknown> = {
			dbt_version: dbtVersion,
			model_count: index.models.size,
			source_count: index.sources.size,
			index_built_at: index.buildTime.toISOString(),
			manifest_path: this.loader.manifestPath,
		};

		if (run_debug) {
			try {
				const debugResult = await this.service.submit({
					type: 'debug',
					args: ['debug'],
					priority: Priority.Tool,
					origin: 'copilot',
					label: 'debug',
				});
				info.debug = formatBridgeResult(debugResult);
			} catch (err) {
				info.debug = { error: `dbt debug failed: ${err instanceof Error ? err.message : String(err)}` };
			}
		}

		return toolResult(info);
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<GetProjectInfoInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Getting dbt project info...' };
	}
}
