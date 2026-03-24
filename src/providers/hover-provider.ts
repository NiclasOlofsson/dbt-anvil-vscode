import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Hover tooltips for ref('model') and source('src','table') references.
 */
export class DbtHoverProvider implements vscode.HoverProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): vscode.Hover | undefined {
		const line = document.lineAt(position.line).text;

		// Match ref('model_name')
		const refMatch = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._hoverRef(match[1]);
			}
		}

		// Match source('source_name', 'table_name')
		const sourceMatch = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				return this._hoverSource(match[1], match[2]);
			}
		}

		return undefined;
	}

	private _hoverRef(modelName: string): vscode.Hover | undefined {
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return undefined;
		const model = models[0];

		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${model.name}** — \`${model.materialisation}\`\n\n`);
		if (model.description) {
			md.appendMarkdown(`${model.description}\n\n`);
		}
		md.appendMarkdown(`- **Package:** ${model.packageName}\n`);
		md.appendMarkdown(`- **Path:** ${model.path}\n`);
		if (model.schema) md.appendMarkdown(`- **Schema:** ${model.schema}\n`);
		if (model.tags.length > 0) md.appendMarkdown(`- **Tags:** ${model.tags.join(', ')}\n`);

		return new vscode.Hover(md);
	}

	private _hoverSource(sourceName: string, tableName: string): vscode.Hover | undefined {
		const index = this.indexer.index;
		if (!index) return undefined;
		const key = `${sourceName}.${tableName}`;
		const uids = index.nodesByName.get(key);
		if (!uids || uids.length === 0) return undefined;

		const source = index.sources.get(uids[0]);
		if (!source) return undefined;

		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${source.sourceName}.${source.name}** — source\n\n`);
		if (source.description) {
			md.appendMarkdown(`${source.description}\n\n`);
		}
		md.appendMarkdown(`- **Schema:** ${source.schema}\n`);
		if (source.database) md.appendMarkdown(`- **Database:** ${source.database}\n`);
		if (source.tags.length > 0) md.appendMarkdown(`- **Tags:** ${source.tags.join(', ')}\n`);

		return new vscode.Hover(md);
	}
}
