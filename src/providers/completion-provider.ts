import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Completions for ref('...') and source('...', '...') inside Jinja SQL files.
 */
export class DbtCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
		_context: vscode.CompletionContext,
	): vscode.CompletionItem[] | undefined {
		const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

		// Inside ref('...')
		if (/ref\(\s*['"][^'"]*$/.test(linePrefix)) {
			return this._completeRef();
		}

		// Inside source('name', '...')  (second argument)
		const sourceSecond = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*$/;
		const sourceSecondMatch = sourceSecond.exec(linePrefix);
		if (sourceSecondMatch) {
			return this._completeSourceTable(sourceSecondMatch[1]);
		}

		// Inside source('...')  (first argument)
		if (/source\(\s*['"][^'"]*$/.test(linePrefix)) {
			return this._completeSourceName();
		}

		return undefined;
	}

	private _completeRef(): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const items: vscode.CompletionItem[] = [];
		const seen = new Set<string>();
		for (const model of index.models.values()) {
			if (seen.has(model.name)) continue;
			seen.add(model.name);
			const item = new vscode.CompletionItem(model.name, vscode.CompletionItemKind.Reference);
			item.detail = `${model.materialisation} — ${model.packageName}`;
			if (model.description) {
				item.documentation = new vscode.MarkdownString(model.description);
			}
			items.push(item);
		}
		return items;
	}

	private _completeSourceName(): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const names = new Set<string>();
		for (const source of index.sources.values()) {
			names.add(source.sourceName);
		}

		return [...names].sort().map(name => {
			const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
			item.detail = 'dbt source';
			return item;
		});
	}

	private _completeSourceTable(sourceName: string): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const items: vscode.CompletionItem[] = [];
		for (const source of index.sources.values()) {
			if (source.sourceName === sourceName) {
				const item = new vscode.CompletionItem(source.name, vscode.CompletionItemKind.Field);
				item.detail = `${source.schema}`;
				if (source.description) {
					item.documentation = new vscode.MarkdownString(source.description);
				}
				items.push(item);
			}
		}
		return items;
	}
}
