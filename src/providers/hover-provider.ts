import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';

/**
 * Hover tooltips for ref('model'), source('src','table'), and macro references.
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
				const hover = this._hoverRef(match[1]);
				this.logger.debug(`Hover: ref('${match[1]}') → ${hover ? 'found' : 'not found'}`);
				return hover;
			}
		}

		// Match source('source_name', 'table_name')
		const sourceMatch = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				const hover = this._hoverSource(match[1], match[2]);
				this.logger.debug(`Hover: source('${match[1]}', '${match[2]}') → ${hover ? 'found' : 'not found'}`);
				return hover;
			}
		}

		// Match macro-like calls inside {{ }}: some_macro(...)
		const macroMatch = /\{\{[^}]*?\b([a-zA-Z_]\w*)\s*\(/g;
		while ((match = macroMatch.exec(line)) !== null) {
			const nameStart = match.index + match[0].length - match[1].length - 1;
			const nameEnd = nameStart + match[1].length;
			if (position.character >= nameStart && position.character <= nameEnd) {
				return this._hoverMacro(match[1]);
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

		// Show columns if available from manifest
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

		// Show columns from manifest
		const raw = this.indexer.getRawNode(uids[0]);
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

	private _hoverMacro(macroName: string): vscode.Hover | undefined {
		// Skip built-in Jinja/dbt functions
		if (['ref', 'source', 'config', 'set', 'if', 'for', 'block', 'macro', 'call'].includes(macroName)) {
			return undefined;
		}

		const index = this.indexer.index;
		if (!index) return undefined;

		// Find the macro by name
		for (const macro of index.macros.values()) {
			if (macro.name === macroName) {
				const md = new vscode.MarkdownString();
				const args = macro.arguments;
				const sig = args.length > 0
					? `(${args.map(a => a.name).join(', ')})`
					: '()';
				md.appendMarkdown(`**${macro.name}**${sig} — macro\n\n`);
				if (macro.description) {
					md.appendMarkdown(`${macro.description}\n\n`);
				}
				md.appendMarkdown(`- **Package:** ${macro.packageName}\n`);

				if (args.length > 0) {
					md.appendMarkdown('\n**Arguments:**\n');
					for (const arg of args) {
						const type = arg.type ? ` \`${arg.type}\`` : '';
						const desc = arg.description ? ` — ${arg.description}` : '';
						md.appendMarkdown(`- \`${arg.name}\`${type}${desc}\n`);
					}
				}

				return new vscode.Hover(md);
			}
		}

		return undefined;
	}
}
