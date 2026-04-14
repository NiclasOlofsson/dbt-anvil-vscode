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
		const actions: vscode.CodeAction[] = [];

		const sqlfluffDiag = context.diagnostics.find(d => d.code === 'sqlfluff-active');
		if (sqlfluffDiag) {
			const action = new vscode.CodeAction('Don\'t warn about SQLFluff', vscode.CodeActionKind.QuickFix);
			action.diagnostics = [sqlfluffDiag];
			action.command = {
				title: 'Suppress SQLFluff warning',
				command: 'dbt-studio.suppressSqlFluffWarning',
			};
			action.isPreferred = true;
			actions.push(action);
		}

		const autoSaveDiag = context.diagnostics.find(d => d.code === 'autosave-active');
		if (autoSaveDiag) {
			const action = new vscode.CodeAction('Don\'t warn about auto-save', vscode.CodeActionKind.QuickFix);
			action.diagnostics = [autoSaveDiag];
			action.command = {
				title: 'Suppress auto-save warning',
				command: 'dbt-studio.suppressAutoSaveWarning',
			};
			action.isPreferred = true;
			actions.push(action);
		}

		const formatterDiag = context.diagnostics.find(d => d.code === 'formatter-not-set');
		if (formatterDiag) {
			const fix = new vscode.CodeAction('Set dbt Studio as default SQL formatter', vscode.CodeActionKind.QuickFix);
			fix.diagnostics = [formatterDiag];
			fix.command = {
				title: 'Set dbt Studio as default formatter',
				command: 'dbt-studio.setAsDefaultFormatter',
			};
			fix.isPreferred = true;

			const suppress = new vscode.CodeAction('Don\'t warn about default formatter', vscode.CodeActionKind.QuickFix);
			suppress.diagnostics = [formatterDiag];
			suppress.command = {
				title: 'Suppress formatter warning',
				command: 'dbt-studio.suppressFormatterWarning',
			};

			actions.push(fix, suppress);
		}

		return actions;

		return [];
	}
}
