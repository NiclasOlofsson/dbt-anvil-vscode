import * as vscode from 'vscode';
import * as path from 'node:path';
import type { DbtCommandResult } from '../dbt/bridge-runner';
import { ServiceContainer } from '../types/service-container';

/**
 * Resolves a tool input path to a Uri. Accepts URIs (`file://...`, `vscode://...`),
 * absolute paths, or project-relative paths.
 *
 * Relative paths resolve against the dbt project, which is what the tools
 * themselves hand out: `get_resource_info` and friends report a manifest node's
 * `original_file_path`, and that is relative to the project. The project is not
 * always the workspace folder, since it can sit nested in a multi-repo workspace.
 */
export function resolvePathToUri(input: string): vscode.Uri {
	if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
		return vscode.Uri.parse(input);
	}
	if (/^[a-zA-Z]:[\\/]|^\//.test(input)) {
		return vscode.Uri.file(input);
	}
	return vscode.Uri.file(path.join(ServiceContainer.getInstance().getManifestIndexer().projectDir, input));
}

export interface StateSelectionResult {
	selector: string | null;
	stateArgs: string[];
}

export function buildStateSelector(
	selectStateModified: boolean | undefined,
	selectStateModifiedPlusDownstream: boolean | undefined,
	stateDir: string,
	select?: string,
): StateSelectionResult {
	if (!selectStateModified) {
		return { selector: select ?? null, stateArgs: [] };
	}
	const stateSelector = selectStateModifiedPlusDownstream
		? 'state:modified+'
		: 'state:modified';
	return {
		selector: stateSelector,
		stateArgs: ['--state', path.join(stateDir, 'state_last_run')],
	};
}

export function toolResult(data: unknown): vscode.LanguageModelToolResult {
	return new vscode.LanguageModelToolResult([
		new vscode.LanguageModelTextPart(JSON.stringify(data, null, 2)),
	]);
}

export function formatBridgeResult(result: DbtCommandResult): Record<string, unknown> {
	return {
		success: result.success,
		output: result.stdout.trim(),
		...(result.stderr.trim() ? { stderr: result.stderr.trim() } : {}),
		...(result.error ? { error: result.error.message } : {}),
	};
}
