import * as vscode from 'vscode';

/**
 * Quick-fix code actions for dbt project configuration files (dbt_project.yml).
 * - SQLFluff active warning → suppress
 * - Auto-save warning → suppress
 */
export class ConfigCodeActionProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	provideCodeActions(
		_document: vscode.TextDocument,
		_range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		_token: vscode.CancellationToken,
	): vscode.CodeAction[] {
		const sqlfluffDiag = context.diagnostics.find(d => d.code === 'sqlfluff-active');
		if (sqlfluffDiag) {
			const action = new vscode.CodeAction('Don\'t show this warning', vscode.CodeActionKind.QuickFix);
			action.diagnostics = [sqlfluffDiag];
			action.command = {
				title: 'Suppress SQLFluff warning',
				command: 'dbt-studio.suppressSqlFluffWarning',
			};
			action.isPreferred = true;
			return [action];
		}

		const autoSaveDiag = context.diagnostics.find(d => d.code === 'autosave-active');
		if (autoSaveDiag) {
			const action = new vscode.CodeAction('Don\'t show this warning', vscode.CodeActionKind.QuickFix);
			action.diagnostics = [autoSaveDiag];
			action.command = {
				title: 'Suppress auto-save warning',
				command: 'dbt-studio.suppressAutoSaveWarning',
			};
			action.isPreferred = true;
			return [action];
		}

		return [];
	}
}
