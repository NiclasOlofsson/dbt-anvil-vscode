import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Find All References for ref('model') and source('src', 'table') using the
 * manifest dependency graph.  Only opens files that the graph identifies as
 * dependents — no workspace-wide scan.
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

		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._findRefUsages(match[1], token);
			}
		}

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
		const index = this.indexer.index;
		if (!index) return [];

		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return [];

		const locations: vscode.Location[] = [];
		const pattern = new RegExp(`ref\\(\\s*['"]${this._escapeRegex(modelName)}['"]\\s*\\)`, 'g');

		for (const model of models) {
			// Include the model definition itself
			if (model.path) {
				locations.push(new vscode.Location(vscode.Uri.file(model.path), new vscode.Position(0, 0)));
			}

			// Use childMap to find downstream dependents
			const childIds = index.childMap.get(model.uniqueId) ?? [];
			const filePaths = this._resolveFilePaths(childIds, index);

			for (const filePath of filePaths) {
				if (token.isCancellationRequested) break;
				const found = await this._findPatternInFile(vscode.Uri.file(filePath), pattern);
				locations.push(...found);
			}
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for ref('${modelName}')`);
		return locations;
	}

	private async _findSourceUsages(sourceName: string, tableName: string, token: vscode.CancellationToken): Promise<vscode.Location[]> {
		const index = this.indexer.index;
		if (!index) return [];

		// Find the source's uniqueId
		const sourceUid = this._findSourceUid(sourceName, tableName, index);
		if (!sourceUid) return [];

		const locations: vscode.Location[] = [];
		const pattern = new RegExp(
			`source\\(\\s*['"]${this._escapeRegex(sourceName)}['"]\\s*,\\s*['"]${this._escapeRegex(tableName)}['"]\\s*\\)`,
			'g',
		);

		const childIds = index.childMap.get(sourceUid) ?? [];
		const filePaths = this._resolveFilePaths(childIds, index);

		for (const filePath of filePaths) {
			if (token.isCancellationRequested) break;
			const found = await this._findPatternInFile(vscode.Uri.file(filePath), pattern);
			locations.push(...found);
		}

		this.logger.debug(`ReferenceProvider: found ${locations.length} references for source('${sourceName}', '${tableName}')`);
		return locations;
	}

	/** Resolve a list of unique IDs to file paths via the models index. */
	private _resolveFilePaths(
		uniqueIds: string[],
		index: import('../indexing/manifest-indexer').ManifestIndex,
	): string[] {
		const paths: string[] = [];
		const seen = new Set<string>();
		for (const uid of uniqueIds) {
			const model = index.models.get(uid);
			if (model?.path && !seen.has(model.path)) {
				seen.add(model.path);
				paths.push(model.path);
			}
		}
		return paths;
	}

	/** Find the source uniqueId by source name + table name. */
	private _findSourceUid(
		sourceName: string,
		tableName: string,
		index: import('../indexing/manifest-indexer').ManifestIndex,
	): string | undefined {
		for (const [uid, src] of index.sources) {
			if (src.sourceName === sourceName && src.name === tableName) return uid;
		}
		return undefined;
	}

	/** Open a single file and find all positions matching the pattern. */
	private async _findPatternInFile(fileUri: vscode.Uri, pattern: RegExp): Promise<vscode.Location[]> {
		const locations: vscode.Location[] = [];
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const text = doc.getText();
			let m;
			pattern.lastIndex = 0;
			while ((m = pattern.exec(text)) !== null) {
				const pos = doc.positionAt(m.index);
				const endPos = doc.positionAt(m.index + m[0].length);
				locations.push(new vscode.Location(fileUri, new vscode.Range(pos, endPos)));
			}
		} catch {
			// File could not be opened — skip
		}
		return locations;
	}

	private _escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}
}
