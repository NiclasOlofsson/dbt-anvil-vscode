import * as vscode from 'vscode';
import type { ILogger } from '../types/logger';
import { resolvePathToUri, toolResult } from './tool-helpers';

interface GetDiagnosticsInput {
	path?: string;
	severity?: 'error' | 'warning' | 'info' | 'hint';
	source?: string;
	max_results?: number;
}

const SEVERITY_NAME: Record<number, 'error' | 'warning' | 'info' | 'hint'> = {
	[vscode.DiagnosticSeverity.Error]: 'error',
	[vscode.DiagnosticSeverity.Warning]: 'warning',
	[vscode.DiagnosticSeverity.Information]: 'info',
	[vscode.DiagnosticSeverity.Hint]: 'hint',
};

export class GetDiagnosticsTool implements vscode.LanguageModelTool<GetDiagnosticsInput> {
	constructor(private readonly logger: ILogger) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<GetDiagnosticsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.LanguageModelToolResult> {
		const { path, severity, source, max_results = 200 } = options.input;
		this.logger.info(`LM Tool: getDiagnostics path="${path ?? '*'}" severity="${severity ?? '*'}" source="${source ?? '*'}"`);

		const entries: Array<[vscode.Uri, readonly vscode.Diagnostic[]]> = path
			? [[resolvePathToUri(path), vscode.languages.getDiagnostics(resolvePathToUri(path))]]
			: vscode.languages.getDiagnostics();

		const results: Array<Record<string, unknown>> = [];
		let total = 0;
		let truncated = false;
		for (const [uri, diags] of entries) {
			for (const d of diags) {
				total++;
				const sev = SEVERITY_NAME[d.severity];
				if (severity && sev !== severity) { continue; }
				if (source && d.source !== source) { continue; }
				if (results.length >= max_results) { truncated = true; continue; }
				results.push({
					file: vscode.workspace.asRelativePath(uri, false),
					line: d.range.start.line + 1,
					column: d.range.start.character + 1,
					end_line: d.range.end.line + 1,
					end_column: d.range.end.character + 1,
					severity: sev,
					source: d.source,
					code: typeof d.code === 'object' && d.code !== null ? d.code.value : d.code,
					message: d.message,
				});
			}
		}

		return toolResult({
			count: results.length,
			total,
			...(truncated ? { truncated: true } : {}),
			diagnostics: results,
		});
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<GetDiagnosticsInput>,
		_token: vscode.CancellationToken,
	): Promise<vscode.PreparedToolInvocation> {
		const scope = options.input.path ? ` for ${options.input.path}` : ' (workspace)';
		return { invocationMessage: `Reading diagnostics${scope}...` };
	}
}
