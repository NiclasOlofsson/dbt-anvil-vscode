import * as vscode from 'vscode';
import type { ManifestIndexer, ManifestIndex } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ILogger } from '../types/logger';

/**
 * Rename ref('model') across the workspace using the manifest dependency graph.
 * Only touches files the graph identifies as dependents — no workspace-wide scan.
 * Also updates schema.yml model name entries and renames the .sql file.
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
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.rename', true)) return undefined;
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

		const index = this.indexer.index;
		if (!index) return undefined;

		this.logger.info(`RenameProvider: renaming '${oldName}' → '${newName}'`);
		const edit = new vscode.WorkspaceEdit();
		const models = this.indexer.findModelsByName(oldName);

		const refPattern = new RegExp(`(ref\\(\\s*['"])${this._escapeRegex(oldName)}(['"]\\s*\\))`, 'g');

		for (const model of models) {
			// 1. Replace ref('old') → ref('new') in downstream dependents only
			const childIds = index.childMap.get(model.uniqueId) ?? [];
			const filePaths = this._resolveFilePaths(childIds, index);

			// Also include the model's own file (it may self-reference or we want to be thorough)
			if (model.path) {
				filePaths.add(model.path);
			}

			for (const filePath of filePaths) {
				if (token.isCancellationRequested) return undefined;
				await this._replaceInFile(vscode.Uri.file(filePath), refPattern, oldName, newName, edit);
			}

			// 2. Update schema.yml entry for this model's own YAML definition
			if (model.path) {
				await this._updateYamlModelName(model.path, oldName, newName, edit, token);
			}

			// 3. Rename the .sql file itself
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

	/** Collect unique file paths from a list of node IDs. */
	private _resolveFilePaths(uniqueIds: string[], index: ManifestIndex): Set<string> {
		const paths = new Set<string>();
		for (const uid of uniqueIds) {
			const model = index.models.get(uid);
			if (model?.path) paths.add(model.path);
		}
		return paths;
	}

	/** Replace ref('oldName') with ref('newName') in a single file. */
	private async _replaceInFile(
		fileUri: vscode.Uri,
		pattern: RegExp,
		oldName: string,
		newName: string,
		edit: vscode.WorkspaceEdit,
	): Promise<void> {
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const text = doc.getText();
			let m;
			pattern.lastIndex = 0;
			while ((m = pattern.exec(text)) !== null) {
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

	/** Find the schema.yml co-located with the model and update `- name: oldName`. */
	private async _updateYamlModelName(
		modelPath: string,
		oldName: string,
		newName: string,
		edit: vscode.WorkspaceEdit,
		token: vscode.CancellationToken,
	): Promise<void> {
		const dir = modelPath.replace(/[/\\][^/\\]+$/, '');
		const ymlNames = ['schema.yml', 'models.yml', 'sources.yml'];
		const nameLineRe = new RegExp(`^(\\s*-\\s*name:\\s*)${this._escapeRegex(oldName)}\\s*$`, 'gm');

		for (const ymlName of ymlNames) {
			if (token.isCancellationRequested) return;
			try {
				const ymlUri = vscode.Uri.file(`${dir}/${ymlName}`);
				const doc = await vscode.workspace.openTextDocument(ymlUri);
				const text = doc.getText();
				let m;
				nameLineRe.lastIndex = 0;
				while ((m = nameLineRe.exec(text)) !== null) {
					const nameIdx = m.index + m[1].length;
					const nameRange = new vscode.Range(
						doc.positionAt(nameIdx),
						doc.positionAt(nameIdx + oldName.length),
					);
					edit.replace(ymlUri, nameRange, newName);
				}
			} catch {
				// YAML file doesn't exist at this location — expected
			}
		}
	}

	private _escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
