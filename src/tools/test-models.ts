import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { toolResult, formatBridgeResult, buildStateSelector } from './tool-helpers';

interface TestModelsInput {
	select: string;
	exclude?: string;
	fail_fast?: boolean;
	select_state_modified?: boolean;
	select_state_modified_plus_downstream?: boolean;
	keep_cte_tests?: boolean;
}

export class TestModelsTool implements vscode.LanguageModelTool<TestModelsInput> {
	constructor(
		private readonly bridge: BridgeRunner,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<TestModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const {
			select, exclude, fail_fast,
			select_state_modified, select_state_modified_plus_downstream,
			keep_cte_tests,
		} = options.input;

		// Generate CTE tests before running dbt test if requested
		if (keep_cte_tests) {
			try {
				const genResult = await this.bridge.invokeRaw({ generate_cte_tests: true });
				if (genResult.success) {
					this.logger.info('CTE tests generated before test run');
				}
			} catch (err) {
				this.logger.warn(`CTE test generation failed: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		const { selector, stateArgs } = buildStateSelector(
			select_state_modified, select_state_modified_plus_downstream, select,
		);
		this.logger.info(`LM Tool: testModels select="${selector ?? 'all'}"`);

		const args = ['test'];
		if (selector) {
			args.push('-s', selector);
		}
		args.push(...stateArgs);

		if (exclude) args.push('--exclude', exclude);
		if (fail_fast) args.push('--fail-fast');

		const result = await this.bridge.invoke(args);
		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<TestModelsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Testing dbt models: ${options.input.select}...` };
	}
}
