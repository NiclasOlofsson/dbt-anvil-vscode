import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Find All References for ref('model') and source('src', 'table') across the workspace.
 */
export class DbtReferenceProvider implements vscode.ReferenceProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	async provideReferences(
		document: vscode.TextDocument,
		position: vscode.Position,
		_context: vscode.ReferenceContext,
		token: vscode.CancellationToken,
	): Promise<vscode.Location[]> {
		const line = document.lineAt(position.line).text;

		// Check if cursor is on a ref('model_name')
		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._findRefUsages(match[1], token);
			}
		}

		// Check if cursor is on a source('src', 'table')
		const sourceRe = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceRe.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._findSourceUsages(match[1], match[2], token);
			}
		}

		return [];
	}

	private async _findRefUsages(modelName: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		this.logger.debug(`ReferenceProvider: searching for ref('${modelName}')`);

		const pattern = `ref\\(\\s*['"]${this._escapeRegex(modelName)}['"]\\s*\\)`;
		const locations = await this._searchWorkspace(pattern, token);

		// Also include the model definition file itself
		const models = this.indexer.findModelsByName(modelName);
		for (const model of models) {
			if (model.path) {
				locations.unshift(new vscode.Location(
					vscode.Uri.file(model.path),
					new vscode.Position(0, 0),
				));
			}
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for '${modelName}'`);
		return locations;
	}

	private async _findSourceUsages(sourceName: string, tableName: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		this.logger.debug(`ReferenceProvider: searching for source('${sourceName}', '${tableName}')`);

		const pattern = `source\\(\\s*['"]${this._escapeRegex(sourceName)}['"]\\s*,\\s*['"]${this._escapeRegex(tableName)}['"]\\s*\\)`;
		const locations = await this._searchWorkspace(pattern, token);

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for source('${sourceName}', '${tableName}')`);
		return locations;
	}

	private async _searchWorkspace(pattern: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const locations: vscode.Location[] = [];

		const sqlFiles = await vscode.workspace.findFiles('**/*.sql', '**/target/**');
		const ymlFiles = await vscode.workspace.findFiles('**/*.yml', '**/target/**');
		const allFiles = [...sqlFiles, ...ymlFiles];

		const regex = new RegExp(pattern, 'g');

		for (const fileUri of allFiles) {
			if (token.isCancellationRequested) break;

			try {
				const doc = await vscode.workspace.openTextDocument(fileUri);
				const text = doc.getText();

				let m;
				regex.lastIndex = 0;
				while ((m = regex.exec(text)) !== null) {
					const pos = doc.positionAt(m.index);
					const endPos = doc.positionAt(m.index + m[0].length);
					locations.push(new vscode.Location(fileUri, new vscode.Range(pos, endPos)));
				}
			} catch {
				// File could not be opened — skip
			}
		}

		return locations;
	}

	private _escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
