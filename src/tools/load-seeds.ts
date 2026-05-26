import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { type DbtExecutionService, Priority } from '../dbt/execution-service';
import { toolResult, formatBridgeResult, buildStateSelector } from './tool-helpers';

interface LoadSeedsInput {
	select?: string;
	exclude?: string;
	full_refresh?: boolean;
	show?: boolean;
	select_state_modified?: boolean;
	select_state_modified_plus_downstream?: boolean;
	confirm_all_resources?: boolean;
}

export class LoadSeedsTool implements vscode.LanguageModelTool<LoadSeedsInput> {
	constructor(
		private readonly service: DbtExecutionService,
		private readonly logger: ILogger,
		private readonly stateDir: string,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<LoadSeedsInput>,
		token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const {
			select, exclude, full_refresh, show,
			select_state_modified, select_state_modified_plus_downstream,
			confirm_all_resources,
		} = options.input;

		if (!select && !select_state_modified && confirm_all_resources !== true) {
			return toolResult({
				success: false,
				error: 'load_seeds requires one of: `select`, `select_state_modified: true`, or `confirm_all_resources: true` (explicit opt-in to load every seed; with `full_refresh: true` this drops + recreates all seed tables).',
			});
		}

		const { selector, stateArgs } = buildStateSelector(
			select_state_modified, select_state_modified_plus_downstream, this.stateDir, select,
		);
		this.logger.info(`LM Tool: loadSeeds select="${selector ?? 'all'}"`);

		const args = ['seed'];
		if (selector) {
			args.push('-s', selector);
		}
		args.push(...stateArgs);

		if (exclude) args.push('--exclude', exclude);
		if (full_refresh) args.push('--full-refresh');
		if (show) args.push('--show');

		const result = await this.service.submit({
			type: 'seed',
			args,
			priority: Priority.Tool,
			origin: 'copilot',
			label: `seed ${selector ?? 'all'}`,
		}, token);
		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<LoadSeedsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const sel = options.input.select ? `: ${options.input.select}` : '';
		return { invocationMessage: `Loading dbt seeds${sel}...` };
	}
}
