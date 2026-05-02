/**
 * Smart IntelliSense for `dbt-studio.layers` inside user / workspace `settings.json`.
 *
 * Triggers in two locations:
 *   1. The `"dbt-studio.layers": ▮` value slot  → offer whole-array scaffolds
 *      driven by live heuristics over the indexed manifest.
 *   2. A new `{ ▮ }` element inside an existing `dbt-studio.layers` array →
 *      offer single-layer scaffolds for the most frequent folders / tags /
 *      name prefixes we observed.
 */

import * as vscode from 'vscode';
import { getLocation, type Location as JsonLocation } from 'jsonc-parser';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import { suggestAll, suggestEntries, type LayerSuggestion, type EntrySuggestion } from '../../indexing/layer-suggestions';
import type { LayerConfig } from '../../indexing/layer-classifier';

const TARGET_PATH = ['dbt-studio.layers'];

export class LayersCompletionProvider implements vscode.CompletionItemProvider {
	constructor(private readonly indexer: ManifestIndexer) { }

	provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.ProviderResult<vscode.CompletionItem[]> {
		if (!isSettingsJson(document)) return;
		const loc = safeGetLocation(document, document.offsetAt(position));
		if (!loc) return;
		if (!pathStartsWith(loc.path, TARGET_PATH)) return;

		const afterTarget = loc.path.slice(TARGET_PATH.length);

		// Case 1: cursor is on the value slot of "dbt-studio.layers" itself
		// (e.g. user typed `"dbt-studio.layers": ▮`). The path is exactly the target.
		if (afterTarget.length === 0) {
			return this.buildArrayCompletions(document, position);
		}

		// Case 2: cursor is inside a new array element object, path like [..., <index>] or
		// [..., <index>, 'match'] etc. We only offer at the object root (empty key slot).
		if (afterTarget.length === 1 && typeof afterTarget[0] === 'number') {
			return this.buildEntryCompletions(document, position);
		}

		return;
	}

	private buildArrayCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
		const items: vscode.CompletionItem[] = [];
		const total = this.indexer.index?.models.size ?? 0;
		const models = total > 0 ? [...this.indexer.index!.models.values()] : [];
		const projectDir = this.indexer.projectDir;

		const suggestions = total > 0 ? suggestAll(models, projectDir) : [];
		for (const sug of suggestions) {
			items.push(this.makeArrayScaffoldItem(sug, document, position));
		}

		// Always offer an empty scaffold as a fallback.
		items.push(this.makeEmptyScaffoldItem(document, position));

		return items;
	}

	private buildEntryCompletions(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem[] {
		const items: vscode.CompletionItem[] = [];
		const total = this.indexer.index?.models.size ?? 0;
		const models = total > 0 ? [...this.indexer.index!.models.values()] : [];
		const projectDir = this.indexer.projectDir;

		const entries = total > 0 ? suggestEntries(models, projectDir) : [];
		for (const entry of entries) {
			items.push(this.makeEntryItem(entry, document, position));
		}
		// Blank single-entry scaffold as a fallback.
		items.push(this.makeBlankEntryItem(document, position));
		return items;
	}

	// --------------- item builders ---------------

	private makeArrayScaffoldItem(sug: LayerSuggestion, document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem {
		const item = new vscode.CompletionItem(
			`dbt Studio: use detected ${sug.kind} layout`,
			vscode.CompletionItemKind.Snippet,
		);
		const pct = sug.total > 0 ? Math.round((sug.matched / sug.total) * 100) : 0;
		item.detail = `${sug.matched}/${sug.total} models (${pct}%) · ${sug.label}`;
		item.documentation = new vscode.MarkdownString(
			`Inserts:\n\`\`\`json\n${stringifyLayersArray(sug.layers)}\n\`\`\``,
		);
		item.insertText = buildArraySnippet(sug.layers);
		item.range = wordRange(document, position);
		item.preselect = true;
		item.sortText = `0_${sug.kind}`;
		return item;
	}

	private makeEmptyScaffoldItem(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem {
		const item = new vscode.CompletionItem(
			'dbt Studio: empty layers scaffold',
			vscode.CompletionItemKind.Snippet,
		);
		item.detail = 'Start with a blank layer entry';
		item.insertText = new vscode.SnippetString(
			'[\n\t{ "name": "${1:raw}", "match": { "folder": "${2:models/raw}" } }$0\n]',
		);
		item.range = wordRange(document, position);
		item.sortText = '9_empty';
		return item;
	}

	private makeEntryItem(entry: EntrySuggestion, document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem {
		const label = `dbt Studio: layer "${entry.layer.name}" (${entry.kind})`;
		const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
		item.detail = `${entry.matched} model(s) match`;
		item.documentation = new vscode.MarkdownString(
			`\`\`\`json\n${JSON.stringify(entry.layer, null, 2)}\n\`\`\``,
		);
		item.insertText = new vscode.SnippetString(stringifyEntrySnippet(entry.layer));
		item.range = wordRange(document, position);
		item.preselect = true;
		item.sortText = `0_${entry.kind}_${entry.layer.name}`;
		return item;
	}

	private makeBlankEntryItem(document: vscode.TextDocument, position: vscode.Position): vscode.CompletionItem {
		const item = new vscode.CompletionItem(
			'dbt Studio: blank layer entry',
			vscode.CompletionItemKind.Snippet,
		);
		item.insertText = new vscode.SnippetString(
			'{ "name": "${1:layer_name}", "match": { "${2|folder,namePrefix,nameRegex,tag,materialization|}": "${3}" } }$0',
		);
		item.range = wordRange(document, position);
		item.sortText = '9_blank';
		return item;
	}
}

// --------------- helpers ---------------

function isSettingsJson(doc: vscode.TextDocument): boolean {
	if (doc.languageId !== 'json' && doc.languageId !== 'jsonc') return false;
	const fsPath = doc.uri.fsPath.replace(/\\/g, '/').toLowerCase();
	return fsPath.endsWith('/settings.json') || fsPath.endsWith('.code-workspace');
}

function safeGetLocation(document: vscode.TextDocument, offset: number): JsonLocation | undefined {
	try {
		return getLocation(document.getText(), offset);
	} catch {
		return undefined;
	}
}

function pathStartsWith(actual: readonly (string | number)[], expected: readonly (string | number)[]): boolean {
	if (actual.length < expected.length) return false;
	for (let i = 0; i < expected.length; i++) {
		if (actual[i] !== expected[i]) return false;
	}
	return true;
}

function wordRange(document: vscode.TextDocument, position: vscode.Position): vscode.Range | undefined {
	// Let the range default to whatever VS Code infers from the trigger position.
	// We return undefined so existing text (like `[]` the user already typed) isn't swallowed,
	// unless there's a word under the cursor we should replace.
	return document.getWordRangeAtPosition(position) ?? undefined;
}

function buildArraySnippet(layers: LayerConfig[]): vscode.SnippetString {
	const body = layers
		.map((l, i) => `\t${stringifyLayerEntry(l, i + 1)}`)
		.join(',\n');
	const snip = new vscode.SnippetString(`[\n${body}\n]$0`);
	return snip;
}

function stringifyLayerEntry(layer: LayerConfig, tabstopBase: number): string {
	// Keep the structure readable; tab stops let users rename layers in sequence.
	const name = `\${${tabstopBase}:${layer.name}}`;
	const matchJson = JSON.stringify(layer.match);
	return `{ "name": "${name}", "match": ${matchJson} }`;
}

function stringifyEntrySnippet(layer: LayerConfig): string {
	const name = `\${1:${layer.name}}`;
	const matchJson = JSON.stringify(layer.match);
	return `{ "name": "${name}", "match": ${matchJson} }$0`;
}

function stringifyLayersArray(layers: LayerConfig[]): string {
	return JSON.stringify(layers, null, 2);
}
