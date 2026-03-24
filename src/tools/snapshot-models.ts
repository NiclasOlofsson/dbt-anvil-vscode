import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { toolResult, formatBridgeResult } from './tool-helpers';

interface SnapshotModelsInput {
	select?: string;
	exclude?: string;
}

export class SnapshotModelsTool implements vscode.LanguageModelTool<SnapshotModelsInput> {
	constructor(
		private readonly bridge: BridgeRunner,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<SnapshotModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { select, exclude } = options.input;
		this.logger.info(`LM Tool: snapshotModels select="${select ?? 'all'}"`);

		const args = ['snapshot'];
		if (select) args.push('-s', select);
		if (exclude) args.push('--exclude', exclude);

		const result = await this.bridge.invoke(args);
		this.loader.invalidate();
		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<SnapshotModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Running dbt snapshots${options.input.select ? ': ' + options.input.select : ''}...` };
	}
}
