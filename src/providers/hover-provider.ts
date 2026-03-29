import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import type { ColumnRefToken, DocumentModel } from '../services/parse-service';
import { isLinePositionInComment } from './comment-utils';
import { SQL_KEYWORDS } from './sql-keywords';
import { resolvePositionContext } from './position-context';

/**
 * Hover tooltips for ref('model'), source('src','table'), macro references,
 * CTE names (showing SQL-derived columns), and column names.
 */
export class DbtHoverProvider implements vscode.HoverProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	async provideHover(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Hover | undefined> {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.hover', true)) return undefined;
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return undefined;

		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService.getDocumentModel(document, dialect);
		if (token.isCancellationRequested || !model) return undefined;

		const ctx = resolvePositionContext(model, line, position);

		if (ctx?.kind === 'ref') {
			const hover = this._hoverRef(ctx.ref.model);
			this.logger.trace(`Hover: ref('${ctx.ref.model}') → ${hover ? 'found' : 'not found'}`);
			return hover;
		}
		if (ctx?.kind === 'source') {
			const hover = this._hoverSource(ctx.source.sourceName, ctx.source.tableName);
			this.logger.trace(`Hover: source('${ctx.source.sourceName}', '${ctx.source.tableName}') → ${hover ? 'found' : 'not found'}`);
			return hover;
		}
		if (ctx?.kind === 'macro') {
			return this._hoverMacro(ctx.name);
		}
		if (ctx?.kind === 'token') {
			// null = AST recognised the token but has nothing to show; suppress fallback
			const hover = this._hoverResolvedToken(model, ctx.resolved, token);
			if (hover !== undefined) return hover ?? undefined;
			return undefined;
		}

		// No token match — try bare-word column fallback
		return this._hoverColumnFallback(document, position, line, model, token);
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
		const found = this.indexer.findSourceByKey(sourceName, tableName);
		if (!found) return undefined;
		const { uid, source } = found;

		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**${source.sourceName}.${source.name}** — source\n\n`);
		if (source.description) {
			md.appendMarkdown(`${source.description}\n\n`);
		}
		md.appendMarkdown(`- **Schema:** ${source.schema}\n`);
		if (source.database) md.appendMarkdown(`- **Database:** ${source.database}\n`);
		if (source.tags.length > 0) md.appendMarkdown(`- **Tags:** ${source.tags.join(', ')}\n`);

		// Show columns from manifest
		const raw = this.indexer.getRawNode(uid);
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
		const macro = this.indexer.findMacroByName(macroName);
		if (!macro) return undefined;

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

	// ---- Token-based hover (AST resolution already done by resolvePositionContext) ----

	// Returns:
	//   Hover  — show this tooltip
	//   null   — AST recognised the token but has nothing to show; suppress fallback
	private _hoverResolvedToken(
		model: DocumentModel,
		resolved: NonNullable<ReturnType<typeof ParseService.resolveAtPosition>>,
		token: vscode.CancellationToken,
	): vscode.Hover | null | undefined {
		if (token.isCancellationRequested) return undefined;
		this.logger.trace(`Hover: token kind='${resolved.kind}' name='${resolved.token.name}'`);

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
				const refTok = resolved.token.resolvedTableRef;
				if (!refTok) return null;
				const cols = ParseService.columnsForRef(refTok, model);
				if (cols) return this._buildAliasHover(resolved.token.table!, cols);
				return null;
			}
			case 'column_def':
				// Column definition (e.g. in a CTE select list) — nothing to hover
				return null;
			case 'column': {
				// Column reference — show column info with source
				const colToken = resolved.token;
				const refTok = colToken.resolvedTableRef;
				if (colToken.table) {
					const cols = refTok ? ParseService.columnsForRef(refTok, model) : undefined;
					this.logger.trace(`Hover: column '${colToken.table}.${colToken.name}' — resolvedTableRef: ${refTok?.name ?? 'none'}, cols: ${cols ? `[${cols.join(', ')}]` : 'none'}`);
					if (cols && (cols.includes('*') || cols.some(c => c.toLowerCase() === colToken.name.toLowerCase()))) {
						const chain = ParseService.traceCteLineage(refTok!, model);
						return this._buildColumnHover(colToken.name, colToken.table, chain);
					}
					// Qualifier resolves to a known alias but its column list is unavailable.
					if (!cols && refTok) {
						const isCte = model.ctes.some(c => c.name.toLowerCase() === refTok.name.toLowerCase());
						if (!isCte) {
							// Direct external ref (ref() / source) in the same scope — show lineage
							const chain = ParseService.traceCteLineage(refTok, model);
							return this._buildColumnHover(colToken.name, colToken.table, chain);
						}
						// CTE defined in this file but column list not available (e.g. macro caller)
						const md = new vscode.MarkdownString();
						md.appendMarkdown(`**${colToken.table}** (alias for \`${refTok.name}\`)\n\n`);
						md.appendMarkdown('_Column list unavailable — `' + refTok.name + '` is not defined in this file._');
						return new vscode.Hover(md);
					}
					// Qualified column with no resolvedTableRef — qualifier not locally defined
					return null;
				}
				// Bare column (qualify-resolved) — resolvedTableRef tells us the exact source
				if (refTok) {
					const cols = ParseService.columnsForRef(refTok, model);
					if (cols && (cols.includes('*') || cols.some(c => c.toLowerCase() === colToken.name.toLowerCase()))) {
						const chain = ParseService.traceCteLineage(refTok, model);
						return this._buildColumnHover(colToken.name, refTok.alias ?? refTok.name, chain);
					}
				}
				return null;
			}
		}
	}

	// ---- Fallback column hover (no token match) ----

	private _hoverColumnFallback(
		document: vscode.TextDocument,
		position: vscode.Position,
		line: string,
		model: DocumentModel,
		token: vscode.CancellationToken,
	): vscode.Hover | undefined {
		if (token.isCancellationRequested) return undefined;
		const prefix = line.substring(0, position.character);
		if (/\{\{[^}]*$/.test(prefix) || /\{%[^%]*$/.test(prefix)) return undefined;

		const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
		if (!wordRange) return undefined;
		const word = document.getText(wordRange);
		if (SQL_KEYWORDS.has(word.toUpperCase())) return undefined;

		// Find the column_ref token at this position, use resolvedTableRef if available
		const colTok = model.tokens.find(
			(t): t is ColumnRefToken => t.type === 'column_ref' && t.name.toLowerCase() === word.toLowerCase() && t.line === position.line,
		);
		if (colTok?.resolvedTableRef) {
			const cols = ParseService.columnsForRef(colTok.resolvedTableRef, model);
			if (cols && (cols.includes('*') || cols.some(c => c.toLowerCase() === word.toLowerCase()))) {
				const chain = ParseService.traceCteLineage(colTok.resolvedTableRef, model);
				return this._buildColumnHover(word, colTok.resolvedTableRef.alias ?? colTok.resolvedTableRef.name, chain);
			}
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
		chain?: string[],
	): vscode.Hover {
		const md = new vscode.MarkdownString();
		md.appendMarkdown(`**\`${column}\`** — column\n\n`);
		if (chain && chain.length > 0) {
			for (let i = 0; i < chain.length; i++) {
				const indent = '&nbsp;&nbsp;'.repeat(i * 2);
				const arrow = i === 0 ? '' : '→ ';
				md.appendMarkdown(`${indent}${arrow}\`${chain[i]}\`  \n`);
			}
		} else if (alias) {
			md.appendMarkdown(`- **Source:** \`${alias}\`\n`);
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


