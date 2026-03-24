import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Completions inside dbt schema.yml files — model names, column names, tags,
 * test names, and source references.
 */
export class YamlCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.CompletionItem[] | undefined {
		const lineText = document.lineAt(position.line).text;
		const linePrefix = lineText.substring(0, position.character);

		// "- name: <cursor>" at model level → suggest model names
		if (/^\s+-\s+name:\s*\S*$/.test(linePrefix) && this._isInModelsBlock(document, position)) {
			return this._completeModelNames();
		}

		// "- name: <cursor>" at column level (deeper indent) → suggest column names for enclosing model
		if (/^\s+-\s+name:\s*\S*$/.test(linePrefix) && this._isInColumnsBlock(document, position)) {
			const modelName = this._findEnclosingModelName(document, position);
			if (modelName) {
				return this._completeColumnNames(modelName);
			}
		}

		// "- <test_name>" under tests: → suggest test names
		if (/^\s+-\s+\S*$/.test(linePrefix) && this._isInTestsBlock(document, position)) {
			return this._completeTestNames();
		}

		return undefined;
	}

	private _isInModelsBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
		for (let i = position.line - 1; i >= 0; i--) {
			const text = document.lineAt(i).text;
			if (/^models:/.test(text)) return true;
			if (/^sources:/.test(text)) return false;
			if (/^\S/.test(text)) return false;
		}
		return false;
	}

	private _isInColumnsBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
		for (let i = position.line - 1; i >= 0; i--) {
			const text = document.lineAt(i).text;
			if (/^\s+columns:/.test(text)) return true;
			if (/^\s+-\s+name:/.test(text) && !/^\s+columns:/.test(document.lineAt(Math.min(i + 1, document.lineCount - 1)).text)) {
				// We hit a "- name:" that is not followed by columns, so we're at model level
				return false;
			}
			if (/^models:|^sources:|^\S/.test(text)) return false;
		}
		return false;
	}

	private _isInTestsBlock(document: vscode.TextDocument, position: vscode.Position): boolean {
		for (let i = position.line - 1; i >= 0; i--) {
			const text = document.lineAt(i).text;
			if (/^\s+tests:/.test(text)) return true;
			if (/^\s+-\s+name:|^\s+columns:|^models:|^sources:|^\S/.test(text)) return false;
		}
		return false;
	}

	private _findEnclosingModelName(document: vscode.TextDocument, position: vscode.Position): string | undefined {
		for (let i = position.line - 1; i >= 0; i--) {
			const text = document.lineAt(i).text;
			const match = /^\s+-\s+name:\s+(\S+)/.exec(text);
			if (match && !this._isInColumnsBlock(document, new vscode.Position(i, 0))) {
				return match[1];
			}
			if (/^models:|^sources:|^\S/.test(text)) break;
		}
		return undefined;
	}

	private _completeModelNames(): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const seen = new Set<string>();
		const items: vscode.CompletionItem[] = [];
		for (const model of index.models.values()) {
			if (seen.has(model.name)) continue;
			seen.add(model.name);
			const item = new vscode.CompletionItem(model.name, vscode.CompletionItemKind.Class);
			item.detail = `${model.materialisation} — ${model.packageName}`;
			if (model.description) {
				item.documentation = new vscode.MarkdownString(model.description);
			}
			items.push(item);
		}
		return items;
	}

	private _completeColumnNames(modelName: string): vscode.CompletionItem[] {
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return [];

		const raw = this.indexer.getRawNode(models[0].uniqueId);
		if (!raw || !raw.columns) return [];

		const items: vscode.CompletionItem[] = [];
		for (const col of Object.values(raw.columns)) {
			const item = new vscode.CompletionItem(col.name, vscode.CompletionItemKind.Field);
			if (col.data_type) item.detail = col.data_type;
			if (col.description) {
				item.documentation = new vscode.MarkdownString(col.description);
			}
			items.push(item);
		}
		return items;
	}

	private _completeTestNames(): vscode.CompletionItem[] {
		const builtIn = ['unique', 'not_null', 'accepted_values', 'relationships'];
		return builtIn.map(name => {
			const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.EnumMember);
			item.detail = 'dbt built-in test';
			return item;
		});
	}
}
