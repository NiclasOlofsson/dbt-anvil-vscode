import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import type { ColumnResolver } from './column-resolver';
import { isLinePositionInComment } from './comment-utils';

/**
 * Hover tooltips for ref('model'), source('src','table'), macro references,
 * CTE names (showing SQL-derived columns), and column names.
 */
export class DbtHoverProvider implements vscode.HoverProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly columnResolver?: ColumnResolver,
		private readonly parseService?: ParseService,
	) {}

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined> {
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return undefined;

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

		// Token-based resolution: CTE names, columns, table aliases.
		// Returns null (not undefined) when the AST recognised the token but had
		// nothing to show — in that case skip the fallback to avoid spurious matches.
		if (this.parseService) {
			const tokenHover = await this._hoverToken(document, position, token);
			if (tokenHover !== undefined) return tokenHover ?? undefined;
		}

		// Fallback: column hover via alias resolution when cursor is on an
		// unrecognised word (AST returned no token for this position).
		if (this.columnResolver) {
			return this._hoverColumnFallback(document, position, line, token);
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

	// ---- Token-based hover (AST position resolution) ----

	// Returns:
	//   Hover  — show this tooltip
	//   null   — AST recognised the token but has nothing to show; suppress fallback
	//   undefined — AST found no token here; caller may run the generic fallback
	private async _hoverToken(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | null | undefined> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService!.getDocumentModel(document, dialect);
		if (token.isCancellationRequested || !model) return undefined;

		const resolved = ParseService.resolveAtPosition(model, position.line, position.character);
		if (!resolved) {
			this.logger.trace(`Hover: no token at ${position.line}:${position.character} (${model.tokens.length} tokens in model)`);
			return undefined;
		}
		this.logger.debug(`Hover: token at ${position.line}:${position.character} → kind='${resolved.kind}' name='${resolved.token.name}'`);

		switch (resolved.kind) {
			case 'table_ref': {
				// Table name in FROM/JOIN — show CTE columns if it's a CTE
				const name = resolved.token.name;
				const cte = model.ctes.find(c =>
					c.name.toLowerCase() === name.toLowerCase()
					|| c.alias?.toLowerCase() === name.toLowerCase(),
				);
				if (cte) return this._buildCteHover(cte);
				return null;
			}
			case 'table_alias': {
				// Alias definition in FROM/JOIN (e.g. the `o` in `FROM orders o`)
				const name = resolved.token.alias!;
				const cte = model.ctes.find(c =>
					c.name.toLowerCase() === resolved.token.name.toLowerCase()
					|| c.alias?.toLowerCase() === name.toLowerCase(),
				);
				if (cte) return this._buildCteHover(cte);
				return null;
			}
			case 'table_qualifier': {
				// Alias prefix of a column ref (e.g. the `o` in `o.order_id`)
				const alias = resolved.token.table!;
				if (this.columnResolver) {
					const aliases = await this.columnResolver.getScopeAliases(document, token);
					if (token.isCancellationRequested) return undefined;
					const cols = aliases[alias] ?? aliases[alias.toLowerCase()];
					if (cols) return this._buildAliasHover(alias, cols);
				}
				return null;
			}
			case 'column': {
				// Column reference — show column info with source
				const colToken = resolved.token;
				if (colToken.table && this.columnResolver) {
					const aliases = await this.columnResolver.getScopeAliases(document, token);
					if (token.isCancellationRequested) return undefined;
					const cols = aliases[colToken.table] ?? aliases[colToken.table.toLowerCase()];
					this.logger.debug(`Hover: column '${colToken.table}.${colToken.name}' — aliases has '${colToken.table}': ${cols ? `[${cols.join(', ')}]` : 'not found'} (${Object.keys(aliases).length} aliases total)`);
					if (cols && cols.some(c => c.toLowerCase() === colToken.name.toLowerCase())) {
						return this._buildColumnHover(colToken.name, colToken.table);
					}
					// Qualified column whose qualifier wasn't resolved — suppress fallback
					// to avoid spurious matches from unrelated tables in the alias map.
					return null;
				} else if (colToken.table) {
					this.logger.debug(`Hover: column '${colToken.table}.${colToken.name}' — no columnResolver configured`);
					return null;
				}
				// Bare column (no table qualifier) — search all aliases
				if (!colToken.table && this.columnResolver) {
					const aliases = await this.columnResolver.getScopeAliases(document, token);
					if (token.isCancellationRequested) return undefined;
					const sources: string[] = [];
					for (const [alias, cols] of Object.entries(aliases)) {
						if (cols.some(c => c.toLowerCase() === colToken.name.toLowerCase())) {
							sources.push(alias);
						}
					}
					if (sources.length > 0) {
						return this._buildColumnHover(
							colToken.name,
							sources.length === 1 ? sources[0] : undefined,
							undefined,
							sources,
						);
					}
				}
				return null;
			}
		}
	}

	// ---- Fallback column hover (no token match) ----

	private async _hoverColumnFallback(
		document: vscode.TextDocument,
		position: vscode.Position,
		line: string,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined> {
		const prefix = line.substring(0, position.character);
		if (/\{\{[^}]*$/.test(prefix) || /\{%[^%]*$/.test(prefix)) return undefined;

		const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
		if (!wordRange) return undefined;
		const word = document.getText(wordRange);
		if (SQL_KEYWORDS.has(word.toUpperCase())) return undefined;

		const aliases = await this.columnResolver!.getScopeAliases(document, token);
		if (token.isCancellationRequested || Object.keys(aliases).length === 0) return undefined;

		// Bare column name — search all aliases
		const sources: string[] = [];
		for (const [alias, cols] of Object.entries(aliases)) {
			if (cols.some(c => c.toLowerCase() === word.toLowerCase())) {
				sources.push(alias);
			}
		}
		if (sources.length > 0) {
			return this._buildColumnHover(word, sources.length === 1 ? sources[0] : undefined, undefined, sources);
		}

		return undefined;
	}

	private _buildCteHover(cte: { name: string; line: number; endLine: number; columns: { name: string; line: number }[] }): vscode.Hover {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**\`${cte.name}\`** — CTE (${cte.columns.length} columns)\n\n`);
		md.appendMarkdown(`- **Lines:** ${cte.line + 1}–${cte.endLine + 1}\n\n`);
		if (cte.columns.length > 0) {
			md.appendMarkdown('**Columns:**\n');
			const display = cte.columns.slice(0, 30);
			for (const col of display) {
				md.appendMarkdown(`- \`${col.name}\` _(line ${col.line + 1})_\n`);
			}
			if (cte.columns.length > 30) {
				md.appendMarkdown(`- _...and ${cte.columns.length - 30} more_\n`);
			}
		}
		return new vscode.Hover(md);
	}

	private _buildColumnHover(
		column: string,
		alias?: string,
		_aliasCols?: string[],
		allSources?: string[],
	): vscode.Hover {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**\`${column}\`** — column\n\n`);
		if (alias) {
			md.appendMarkdown(`- **Source:** \`${alias}\`\n`);
		} else if (allSources && allSources.length > 0) {
			md.appendMarkdown(`- **Available in:** ${allSources.map(s => '`' + s + '`').join(', ')}\n`);
		}
		return new vscode.Hover(md);
	}

	private _buildAliasHover(alias: string, cols: string[]): vscode.Hover {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**\`${alias}\`** — CTE / table alias (${cols.length} columns)\n\n`);
		const display = cols.slice(0, 20);
		for (const col of display) {
			md.appendMarkdown(`- \`${col}\`\n`);
		}
		if (cols.length > 20) {
			md.appendMarkdown(`- _...and ${cols.length - 20} more_\n`);
		}
		return new vscode.Hover(md);
	}
}

const SQL_KEYWORDS = new Set([
	'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'ON', 'AS',
	'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS',
	'GROUP', 'BY', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'UNION',
	'INSERT', 'INTO', 'UPDATE', 'DELETE', 'SET', 'VALUES', 'CREATE',
	'ALTER', 'DROP', 'TABLE', 'VIEW', 'INDEX', 'WITH', 'CASE', 'WHEN',
	'THEN', 'ELSE', 'END', 'BETWEEN', 'LIKE', 'IS', 'NULL', 'TRUE',
	'FALSE', 'DISTINCT', 'ALL', 'EXISTS', 'ANY', 'SOME', 'ASC', 'DESC',
	'OVER', 'PARTITION', 'ROWS', 'RANGE', 'UNBOUNDED', 'PRECEDING',
	'FOLLOWING', 'CURRENT', 'ROW', 'WINDOW', 'FILTER', 'WITHIN',
	'CAST', 'COALESCE', 'NULLIF', 'IF', 'IIF',
]);
