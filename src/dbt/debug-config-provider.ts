import * as vscode from 'vscode';

const DEBUG_TYPE = 'dbt-sql';

/**
 * Provides default debug configurations so F5 works without a launch.json.
 */
export class SqlDebugConfigProvider implements vscode.DebugConfigurationProvider {

	resolveDebugConfiguration(
		_folder: vscode.WorkspaceFolder | undefined,
		config: vscode.DebugConfiguration,
		_token?: vscode.CancellationToken,
	): vscode.DebugConfiguration | undefined {
		// When F5 is pressed with no launch.json, config is almost empty ({ type, request })
		// or completely empty ({}). Fill in defaults.
		if (!config.type && !config.request && !config.name) {
			const editor = vscode.window.activeTextEditor;
			if (!editor || editor.document.languageId !== 'jinja-sql') {
				return undefined; // Let VS Code show its normal "no debug config" message
			}
			config.type = DEBUG_TYPE;
			config.request = 'launch';
			config.name = 'Run SQL';
		}

		// Fill in defaults from settings
		if (config.limit === undefined) {
			config.limit = vscode.workspace.getConfiguration('dbt-studio').get<number>('queryEditor.defaultLimit', 500);
		}
		if (!config.scope) {
			config.scope = 'cursor';
		}

		return config;
	}

	provideDebugConfigurations(
		_folder: vscode.WorkspaceFolder | undefined,
		_token?: vscode.CancellationToken,
	): vscode.DebugConfiguration[] {
		return [
			{
				name: 'Run SQL',
				type: DEBUG_TYPE,
				request: 'launch',
			},
			{
				name: 'Run All SQL',
				type: DEBUG_TYPE,
				request: 'launch',
				scope: 'all',
			},
			{
				name: 'Run SQL (no limit)',
				type: DEBUG_TYPE,
				request: 'launch',
				limit: -1,
			},
		];
	}
}
