import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Go-to-definition for ref('model_name') and source('source', 'table').
 */
export class DbtDefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.Definition | undefined {
		const line = document.lineAt(position.line).text;

		// Match ref('model_name') or ref("model_name")
		const refMatch = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._resolveRef(match[1]);
			}
		}

		// Match source('source_name', 'table_name')
		const sourceMatch = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._resolveSource(match[1], match[2]);
			}
		}

		return undefined;
	}

	private _resolveRef(modelName: string): vscode.Location | undefined {
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return undefined;
		const model = models[0];
		if (!model.path) return undefined;
		try {
			return new vscode.Location(vscode.Uri.file(model.path), new vscode.Position(0, 0));
		} catch {
			return undefined;
		}
	}

	private _resolveSource(sourceName: string, tableName: string): vscode.Location | undefined {
		const index = this.indexer.index;
		if (!index) return undefined;
		const key = `${sourceName}.${tableName}`;
		const uids = index.nodesByName.get(key);
		if (!uids || uids.length === 0) return undefined;

		const source = index.sources.get(uids[0]);
		if (!source) return undefined;

		// Sources don't have a file path in the same way — could point to schema.yml
		// For now, we can't resolve file location for sources
		return undefined;
	}
}
