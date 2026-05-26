import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult, formatBridgeResult, buildStateSelector } from './tool-helpers';

interface RunModelsInput {
	select?: string;
	exclude?: string;
	full_refresh?: boolean;
	fail_fast?: boolean;
	cache_selected_only?: boolean;
	select_state_modified?: boolean;
	select_state_modified_plus_downstream?: boolean;
	confirm_all_resources?: boolean;
}

export class RunModelsTool implements vscode.LanguageModelTool<RunModelsInput> {
	constructor(
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
		private readonly stateDir: string,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<RunModelsInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const {
			select, exclude, full_refresh, fail_fast,
			cache_selected_only = true,
			select_state_modified, select_state_modified_plus_downstream,
			confirm_all_resources,
		} = options.input;

		if (!select && !select_state_modified && confirm_all_resources !== true) {
			return toolResult({
				success: false,
				error: 'run_models requires one of: `select` (node selection expression), `select_state_modified: true`, or `confirm_all_resources: true` (explicit opt-in to run every model in the project).',
			});
		}

		const { selector, stateArgs } = buildStateSelector(
			select_state_modified, select_state_modified_plus_downstream, this.stateDir, select,
		);
		this.logger.info(`LM Tool: runModels select="${selector ?? 'all'}"`);

		const args = ['run'];

		if (cache_selected_only && selector) {
			args.push('--cache-selected-only');
		}

		if (selector) {
			args.push('-s', selector);
		}
		args.push(...stateArgs);

		if (exclude) args.push('--exclude', exclude);
		if (full_refresh) args.push('--full-refresh');
		if (fail_fast) args.push('--fail-fast');

		const result = await this.service.submit({
			type: 'run',
			args,
			priority: Priority.Tool,
			origin: 'copilot',
			label: `run ${selector ?? 'all'}`,
		}, token);

		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<RunModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Running dbt models: ${options.input.select ?? 'all'}...` };
	}
}
