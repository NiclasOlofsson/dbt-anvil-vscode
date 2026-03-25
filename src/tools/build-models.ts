import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult, formatBridgeResult, buildStateSelector } from './tool-helpers';

interface BuildModelsInput {
	select: string;
	exclude?: string;
	full_refresh?: boolean;
	resource_types?: string[];
	fail_fast?: boolean;
	cache_selected_only?: boolean;
	select_state_modified?: boolean;
	select_state_modified_plus_downstream?: boolean;
}

export class BuildModelsTool implements vscode.LanguageModelTool<BuildModelsInput> {
	constructor(
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<BuildModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const {
			select, exclude, full_refresh, resource_types, fail_fast,
			cache_selected_only = true,
			select_state_modified, select_state_modified_plus_downstream,
		} = options.input;

		const { selector, stateArgs } = buildStateSelector(
			select_state_modified, select_state_modified_plus_downstream, select,
		);
		this.logger.info(`LM Tool: buildModels select="${selector ?? 'all'}"`);

		const args = ['build'];

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
		if (resource_types) {
			for (const rt of resource_types) {
				args.push('--resource-type', rt);
			}
		}

		const result = await this.service.submit({
			type: 'build',
			args,
			priority: Priority.Tool,
			origin: 'copilot',
			label: `build ${selector ?? 'all'}`,
		});

		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<BuildModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Building dbt models: ${options.input.select}...` };
	}
}
