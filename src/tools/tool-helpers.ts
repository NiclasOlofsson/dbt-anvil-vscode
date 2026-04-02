import * as vscode from 'vscode';
import * as path from 'node:path';
import type { DbtCommandResult } from '../dbt/bridge-runner';

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
