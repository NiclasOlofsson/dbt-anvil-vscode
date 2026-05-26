import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult, formatBridgeResult } from './tool-helpers';

export class InstallDepsTool implements vscode.LanguageModelTool<Record<string, never>> {
	constructor(
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
	) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<Record<string, never>>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		this.logger.info('LM Tool: installDeps');

		const result = await this.service.submit({
			type: 'deps',
			args: ['deps'],
			priority: Priority.Tool,
			origin: 'copilot',
			label: 'install deps',
		}, token);
		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		_options: vscode.LanguageModelToolInvocationPrepareOptions<Record<string, never>>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: 'Installing dbt dependencies...' };
	}
}
