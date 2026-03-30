import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { DbtSymbolKind } from './common/icons';

/**
 * Workspace-wide symbol search (Ctrl+T / Cmd+T).
 * Searches across all models, sources, and macros from the manifest index.
 */
export class DbtWorkspaceSymbolProvider implements vscode.WorkspaceSymbolProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideWorkspaceSymbols(
		query: string,
		_token: vscode.CancellationToken,
	): vscode.SymbolInformation[] {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.workspaceSymbols', true)) return [];
		const index = this.indexer.index;
		if (!index) return [];

		const lowerQuery = query.toLowerCase();
		const results: vscode.SymbolInformation[] = [];

		// Search models
		for (const model of index.models.values()) {
			if (model.name.toLowerCase().includes(lowerQuery)) {
				results.push(new vscode.SymbolInformation(
					model.name,
					DbtSymbolKind.model,
					`${model.materialisation} — ${model.packageName}`,
					new vscode.Location(
						vscode.Uri.file(model.path),
						new vscode.Position(0, 0),
					),
				));
			}
		}

		// Search sources
		for (const source of index.sources.values()) {
			const displayName = `${source.sourceName}.${source.name}`;
			if (displayName.toLowerCase().includes(lowerQuery) || source.name.toLowerCase().includes(lowerQuery)) {
				results.push(new vscode.SymbolInformation(
					displayName,
					DbtSymbolKind.source,
					`source — ${source.schema}`,
					new vscode.Location(
						// Sources don't have a file path, use a placeholder
						vscode.Uri.file(''),
						new vscode.Position(0, 0),
					),
				));
			}
		}

		// Search macros
		for (const macro of index.macros.values()) {
			if (macro.name.toLowerCase().includes(lowerQuery)) {
				const args = macro.arguments.map(a => a.name).join(', ');
				results.push(new vscode.SymbolInformation(
					macro.name,
					DbtSymbolKind.macro,
					`${macro.packageName}${args ? ` — (${args})` : ''}`,
					new vscode.Location(
						vscode.Uri.file(''),
						new vscode.Position(0, 0),
					),
				));
			}
		}

		this.logger.debug(`WorkspaceSymbol: '${query}' → ${results.length} results`);
		return results;
	}
}
