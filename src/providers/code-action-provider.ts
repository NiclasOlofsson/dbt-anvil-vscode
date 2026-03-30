import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Quick-fix code actions for dbt SQL files.
 * - Unknown ref('model') → create model file
 * - Unknown source → suggestion to check source definition
 */
export class DbtCodeActionProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		context: vscode.CodeActionContext,
		_token: vscode.CancellationToken,
	): vscode.CodeAction[] {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.codeActions', true)) return [];

		// SQLFluff active warning quick fix — available on dbt_project.yml
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

		// Auto-save warning quick fix — available on dbt_project.yml
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

		if (document.languageId !== 'jinja-sql') return [];

		const actions: vscode.CodeAction[] = [];
		const line = document.lineAt(range.start.line).text;

		// Check for ref('model_name') where model doesn't exist
		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const modelName = match[1];
			const models = this.indexer.findModelsByName(modelName);
			if (models.length === 0) {
				const action = new vscode.CodeAction(
					`Create model '${modelName}.sql'`,
					vscode.CodeActionKind.QuickFix,
				);
				action.command = {
					title: `Create ${modelName}.sql`,
					command: 'dbt-studio.createModelFile',
					arguments: [modelName],
				};
				action.isPreferred = true;
				actions.push(action);
				this.logger.debug(`CodeAction: offering to create model '${modelName}'`);
			}
		}

		return actions;
	}
}
