import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestLoader } from '../dbt/manifest-loader';
import { toolResult, formatBridgeResult } from './tool-helpers';

interface CompileModelInput {
	model: string;
}

export class CompileModelTool implements vscode.LanguageModelTool<CompileModelInput> {
	constructor(
		private readonly bridge: BridgeRunner,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CompileModelInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { model } = options.input;
		this.logger.info(`LM Tool: compileModel model="${model}"`);

		const result = await this.bridge.invoke(['compile', '-s', model]);
		this.loader.invalidate();

		if (result.success) {
			try {
				const { manifest } = this.loader.load(true);
				for (const node of Object.values(manifest.nodes)) {
					if (node.name === model && node.compiled_code) {
						return toolResult({
							success: true,
							model,
							compiled_sql: node.compiled_code,
						});
					}
				}
			} catch {
				// Fall through to raw output
			}
		}

		return toolResult(formatBridgeResult(result));
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CompileModelInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Compiling dbt model: ${options.input.model}...` };
	}
}
