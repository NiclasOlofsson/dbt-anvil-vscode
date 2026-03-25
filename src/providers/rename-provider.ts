import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ILogger } from '../types/logger';

/**
 * Rename ref('model') across the workspace — renames all ref() calls,
 * updates schema.yml model name entries, and renames the .sql file.
 */
export class DbtRenameProvider implements vscode.RenameProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
	) {}

	prepareRename(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.Range | { range: vscode.Range; placeholder: string }> {
		const line = document.lineAt(position.line).text;

		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const nameStart = match.index + match[0].indexOf(match[1]);
			const nameEnd = nameStart + match[1].length;
			if (position.character >= nameStart && position.character <= nameEnd) {
				const range = new vscode.Range(
					new vscode.Position(position.line, nameStart),
					new vscode.Position(position.line, nameEnd),
				);
				return { range, placeholder: match[1] };
			}
		}

		throw new Error('Cannot rename this element — place cursor on a ref() model name.');
	}

	async provideRenameEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
		token: vscode.CancellationToken,
	): Promise<vscode.WorkspaceEdit | undefined> {
		const line = document.lineAt(position.line).text;

		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		let oldName: string | undefined;

		while ((match = refRe.exec(line)) !== null) {
			const nameStart = match.index + match[0].indexOf(match[1]);
			const nameEnd = nameStart + match[1].length;
			if (position.character >= nameStart && position.character <= nameEnd) {
				oldName = match[1];
				break;
			}
		}

		if (!oldName) return undefined;

		this.logger.info(`RenameProvider: renaming '${oldName}' → '${newName}'`);
		const edit = new vscode.WorkspaceEdit();

		// 1. Replace all ref('old') → ref('new') across SQL files
		const sqlFiles = await vscode.workspace.findFiles('**/*.sql', '**/target/**');
		const refPattern = new RegExp(`(ref\\(\\s*['"])${this._escapeRegex(oldName)}(['"]\\s*\\))`, 'g');

		for (const fileUri of sqlFiles) {
			if (token.isCancellationRequested) return undefined;
			try {
				const doc = await vscode.workspace.openTextDocument(fileUri);
				const text = doc.getText();
				let m;
				refPattern.lastIndex = 0;
				while ((m = refPattern.exec(text)) !== null) {
					const nameIdx = m.index + m[1].length;
					const nameRange = new vscode.Range(
						doc.positionAt(nameIdx),
						doc.positionAt(nameIdx + oldName.length),
					);
					edit.replace(fileUri, nameRange, newName);
				}
			} catch {
				// skip
			}
		}

		// 2. Replace model name in schema.yml files
		const ymlFiles = await vscode.workspace.findFiles('**/{schema,sources,models}.yml', '**/target/**');
		const nameLineRe = new RegExp(`^(\\s*-\\s*name:\\s*)${this._escapeRegex(oldName)}\\s*$`, 'gm');

		for (const fileUri of ymlFiles) {
			if (token.isCancellationRequested) return undefined;
			try {
				const doc = await vscode.workspace.openTextDocument(fileUri);
				const text = doc.getText();
				let m;
				nameLineRe.lastIndex = 0;
				while ((m = nameLineRe.exec(text)) !== null) {
					const nameIdx = m.index + m[1].length;
					const nameRange = new vscode.Range(
						doc.positionAt(nameIdx),
						doc.positionAt(nameIdx + oldName.length),
					);
					edit.replace(fileUri, nameRange, newName);
				}
			} catch {
				// skip
			}
		}

		// 3. Rename the model .sql file itself
		const models = this.indexer.findModelsByName(oldName);
		for (const model of models) {
			if (model.path) {
				const oldUri = vscode.Uri.file(model.path);
				const dir = model.path.replace(/[/\\][^/\\]+$/, '');
				const newUri = vscode.Uri.file(`${dir}/${newName}.sql`);
				edit.renameFile(oldUri, newUri);
			}
		}

		this.logger.info(`RenameProvider: created ${edit.entries().length} edit entries`);
		return edit;
	}

	private _escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
