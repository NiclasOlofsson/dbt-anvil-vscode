import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { toolResult, formatBridgeResult, buildStateSelector } from './tool-helpers';

interface LoadSeedsInput {
	select?: string;
	exclude?: string;
	full_refresh?: boolean;
	show?: boolean;
	select_state_modified?: boolean;
	select_state_modified_plus_downstream?: boolean;
}

export class LoadSeedsTool implements vscode.LanguageModelTool<LoadSeedsInput> {
	constructor(
		private readonly bridge: BridgeRunner,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<LoadSeedsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const {
			select, exclude, full_refresh, show,
			select_state_modified, select_state_modified_plus_downstream,
		} = options.input;

		const { selector, stateArgs } = buildStateSelector(
			select_state_modified, select_state_modified_plus_downstream, select,
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

		const result = await this.bridge.invoke(args);
		this.loader.invalidate();
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
