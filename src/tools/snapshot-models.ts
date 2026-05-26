import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult, formatBridgeResult } from './tool-helpers';

interface SnapshotModelsInput {
	select?: string;
	exclude?: string;
	confirm_all_resources?: boolean;
}

export class SnapshotModelsTool implements vscode.LanguageModelTool<SnapshotModelsInput> {
	constructor(
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SnapshotModelsInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { select, exclude, confirm_all_resources } = options.input;

		if (!select && confirm_all_resources !== true) {
			return toolResult({
				success: false,
				error: 'snapshot_models requires either `select` or `confirm_all_resources: true` (explicit opt-in to run every snapshot in the project).',
			});
		}

		this.logger.info(`LM Tool: snapshotModels select="${select ?? 'all'}"`);

		const args = ['snapshot'];
		if (select) args.push('-s', select);
		if (exclude) args.push('--exclude', exclude);

		const result = await this.service.submit({
			type: 'snapshot',
			args,
			priority: Priority.Tool,
			origin: 'copilot',
			label: `snapshot ${select ?? 'all'}`,
		}, token);
		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<SnapshotModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Running dbt snapshots${options.input.select ? ': ' + options.input.select : ''}...` };
	}
}
