import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Completions for ref(), source(), macros, and columns inside Jinja SQL files.
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

		// Inside {{ ... }} — complete macro names
		if (/\{\{[^}]*$/.test(linePrefix) && !/(?:ref|source)\(\s*['"]/.test(linePrefix)) {
			return this._completeMacros();
		}

		return undefined;
	}

	private _completeRef(): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const items: vscode.CompletionItem[] = [];
		const byName = new Map<string, typeof items>();

		for (const model of index.models.values()) {
			if (!byName.has(model.name)) {
				byName.set(model.name, []);
			}
			const item = new vscode.CompletionItem(model.name, vscode.CompletionItemKind.Reference);
			item.detail = `${model.materialisation} — ${model.packageName}`;
			if (model.description) {
				item.documentation = new vscode.MarkdownString(model.description);
			}
			byName.get(model.name)!.push(item);
		}

		// If a name exists in multiple packages, qualify them all
		for (const [name, group] of byName) {
			if (group.length === 1) {
				items.push(group[0]);
			} else {
				for (const item of group) {
					item.label = name;
					item.sortText = `${name}__${item.detail}`;
					items.push(item);
				}
			}
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

	private _completeMacros(): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const items: vscode.CompletionItem[] = [];
		for (const macro of index.macros.values()) {
			const item = new vscode.CompletionItem(macro.name, vscode.CompletionItemKind.Function);
			item.detail = macro.packageName;

			const args = macro.arguments;
			if (args.length > 0) {
				const sig = args.map(a => a.name).join(', ');
				item.detail = `${macro.packageName} — (${sig})`;
			}

			if (macro.description) {
				item.documentation = new vscode.MarkdownString(macro.description);
			}

			// Insert as function call with parentheses
			item.insertText = new vscode.SnippetString(`${macro.name}($0)`);
			items.push(item);
		}
		return items;
	}
}
