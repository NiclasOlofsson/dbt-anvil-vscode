import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { toolResult } from './tool-helpers';

interface WorkspaceSymbolsInput {
	query: string;
	max_results?: number;
}

export class WorkspaceSymbolsTool implements vscode.LanguageModelTool<WorkspaceSymbolsInput> {
	constructor(private readonly logger: ILogger) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<WorkspaceSymbolsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { query, max_results = 100 } = options.input;
		this.logger.info(`LM Tool: workspaceSymbols query="${query}"`);

		const symbols = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
			'vscode.executeWorkspaceSymbolProvider',
			query,
		) ?? [];

		const results = symbols.slice(0, max_results).map(s => ({
			name: s.name,
			kind: vscode.SymbolKind[s.kind],
			container: s.containerName || undefined,
			file: vscode.workspace.asRelativePath(s.location.uri, false),
			line: s.location.range.start.line + 1,
			column: s.location.range.start.character + 1,
		}));

		return toolResult({
			count: results.length,
			total: symbols.length,
			...(symbols.length > results.length ? { truncated: true } : {}),
			symbols: results,
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<WorkspaceSymbolsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		return { invocationMessage: `Searching workspace symbols: "${options.input.query}"...` };
	}
}
