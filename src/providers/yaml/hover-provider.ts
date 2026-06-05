import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';

/**
 * Hover tooltips in dbt schema.yml files — shows model/source metadata
 * when hovering over a model or source name.
 */
export class YamlHoverProvider implements vscode.HoverProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
	): vscode.Hover | undefined {
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.yaml.hover', true)) return undefined;
		const lineText = document.lineAt(position.line).text;

		// Match "- name: <model_name>" lines
		const nameMatch = /^\s+-\s+name:\s+(\S+)/.exec(lineText);
		if (nameMatch) {
			const name = nameMatch[1];
			const nameStart = lineText.indexOf(name, lineText.indexOf('name:') + 5);
			const nameEnd = nameStart + name.length;

			if (position.character >= nameStart && position.character <= nameEnd) {
				// Try as model first, then source
				return this._hoverModel(name) ?? this._hoverSourceByTable(name);
			}
		}

		return undefined;
	}

	private _hoverModel(modelName: string): vscode.Hover | undefined {
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return undefined;
		const model = models[0];

		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${model.name}** — \`${model.materialisation}\`\n\n`);
		if (model.description) {
			md.appendMarkdown(`${model.description}\n\n`);
		}
		md.appendMarkdown(`- **Package:** ${model.packageName}\n`);
		if (model.schema) md.appendMarkdown(`- **Schema:** ${model.schema}\n`);
		if (model.tags.length > 0) md.appendMarkdown(`- **Tags:** ${model.tags.join(', ')}\n`);

		const raw = this.indexer.getRawNode(model.uniqueId);
		if (raw && raw.columns && Object.keys(raw.columns).length > 0) {
			md.appendMarkdown('\n**Columns:**\n');
			for (const col of Object.values(raw.columns)) {
				const type = col.data_type ? ` \`${col.data_type}\`` : '';
				const desc = col.description ? ` — ${col.description}` : '';
				md.appendMarkdown(`- \`${col.name}\`${type}${desc}\n`);
			}
		}

		return new vscode.Hover(md);
	}

	private _hoverSourceByTable(tableName: string): vscode.Hover | undefined {
		const index = this.indexer.index;
		if (!index) return undefined;

		for (const source of index.sources.values()) {
			if (source.name === tableName) {
				const md = new vscode.MarkdownString();
				md.appendMarkdown(`**${source.sourceName}.${source.name}** — source\n\n`);
				if (source.description) {
					md.appendMarkdown(`${source.description}\n\n`);
				}
				md.appendMarkdown(`- **Schema:** ${source.schema}\n`);
				if (source.database) md.appendMarkdown(`- **Database:** ${source.database}\n`);
				return new vscode.Hover(md);
			}
		}

		return undefined;
	}
}
