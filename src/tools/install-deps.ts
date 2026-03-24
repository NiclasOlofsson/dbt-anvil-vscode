import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { toolResult, formatBridgeResult } from './tool-helpers';

export class InstallDepsTool implements vscode.LanguageModelTool<Record<string, never>> {
	constructor(
		private readonly bridge: BridgeRunner,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		this.logger.info('LM Tool: installDeps');

		const result = await this.bridge.invoke(['deps']);
		this.loader.invalidate();
		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Installing dbt dependencies...' };
	}
}
