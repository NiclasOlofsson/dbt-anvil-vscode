import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import type { ColumnRefToken, DocumentModel, TableRefToken } from '../services/parse-service';
import { isLinePositionInComment } from './comment-utils';
import { SQL_KEYWORDS } from './sql-keywords';
import { resolvePositionContext } from './position-context';
import { DbtMaterializationIcons, SqlIcons } from './icons';

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
			const hover = this._hoverResolvedToken(model, ctx.resolved, token, document.uri);
			if (hover !== undefined) return hover ?? undefined;
			return undefined;
		}

		// No token match — try bare-word column fallback
		return this._hoverColumnFallback(document, position, line, model, token);
	}

	private _md(): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = true;
		md.isTrusted = { enabledCommands: ['dbt-studio.goToLine'] };
		return md;
	}

	private _lineLink(uri: vscode.Uri, line: number, label: string): string {
		const args = encodeURIComponent(JSON.stringify({ uri: uri.toString(), line }));
		return `[\`${label}\`](command:dbt-studio.goToLine?${args})`;
	}

	private _externalRefLabel(modelName: string, docUri?: vscode.Uri): string {
		const models = this.indexer.findModelsByName(modelName);
		let resolved = models[0];

		// When multiple packages define the same model name, use the current
		// document's depends_on.nodes to pick the exact edge being traversed.
		if (models.length > 1 && docUri) {
			const uid = this.indexer.findModelByFilePath(docUri.fsPath);
			if (uid) {
				const raw = this.indexer.getRawNode(uid);
				if (raw && 'depends_on' in raw) {
					const dep = models.find(m => raw.depends_on.nodes.includes(m.uniqueId));
					if (dep) resolved = dep;
				}
			}
		}

		const iconName = resolved
			? (DbtMaterializationIcons[resolved.materialisation] ?? DbtMaterializationIcons['default'])
			: DbtMaterializationIcons['default'];
		if (resolved?.path) {
			try {
				const uri = vscode.Uri.file(resolved.path);
				return `$(${iconName}) ${this._lineLink(uri, 0, modelName)}`;
			} catch { /* no-op */ }
		}
		return `$(${iconName}) \`${modelName}\``;
	}

	private _chainEntryLabel(
		entry: string,
		cteByName: Map<string, { name: string; line: number }>,
		docUri?: vscode.Uri,
	): string {
		const refMatch = entry.match(/^ref\('(.+)'\)$/);
		if (refMatch) return this._externalRefLabel(refMatch[1], docUri);
		const cte = cteByName.get(entry.toLowerCase());
		if (cte && docUri) return `$(${SqlIcons.cte}) ${this._lineLink(docUri, cte.line, cte.name)}`;
		// Plain name — raw hardcoded table reference (not a ref(), not a CTE)
		return `$(${SqlIcons.file}) \`${entry}\``;
	}

	private _hoverRef(modelName: string): vscode.Hover | undefined {
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return undefined;
		const model = models[0];

		const md = this._md();
		const qualifiedName = model.schema ? `${model.schema}.${model.name}` : model.name;
		const icon = DbtMaterializationIcons[model.materialisation] ?? DbtMaterializationIcons.default;
		md.appendMarkdown(`$(${icon}) **\`${qualifiedName}\`** — model · _${model.materialisation}_`);
		if (model.description) {
			md.appendMarkdown(`\n\n${model.description}`);
		}

		const metaLines: string[] = [
			`$(${SqlIcons.package}) \`${model.packageName}\``,
			`$(${SqlIcons.file}) \`${model.path}\``,
		];
		if (model.schema) metaLines.push(`$(${SqlIcons.database}) \`${model.schema}\``);
		if (model.tags.length > 0) {
			metaLines.push(`$(${SqlIcons.tag}) ${model.tags.map(t => `\`${t}\``).join(' ')}`);
		}
		md.appendMarkdown('\n\n---\n\n' + metaLines.join('  \n'));

		const raw = this.indexer.getRawNode(model.uniqueId);
		if (raw && raw.columns && Object.keys(raw.columns).length > 0) {
			md.appendMarkdown('\n\n---\n\n**Columns**  \n');
			for (const col of Object.values(raw.columns)) {
				const type = col.data_type ? ` _${col.data_type}_` : '';
				const desc = col.description ? ` — ${col.description}` : '';
				md.appendMarkdown(`$(${SqlIcons.column}) \`${col.name}\`${type}${desc}  \n`);
			}
		}

		return new vscode.Hover(md);
	}

	private _hoverSource(sourceName: string, tableName: string): vscode.Hover | undefined {
		const found = this.indexer.findSourceByKey(sourceName, tableName);
		if (!found) return undefined;
		const { uid, source } = found;

		const md = this._md();
		md.appendMarkdown(`$(${SqlIcons.source}) **\`${source.sourceName}.${source.name}\`** — source`);
		if (source.description) {
			md.appendMarkdown(`\n\n${source.description}`);
		}

		const metaLines: string[] = [`$(${SqlIcons.schema}) \`${source.schema}\``];
		if (source.database) metaLines.push(`$(${SqlIcons.database}) \`${source.database}\``);
		if (source.tags.length > 0) {
			metaLines.push(`$(${SqlIcons.tag}) ${source.tags.map(t => `\`${t}\``).join(' ')}`);
		}
		md.appendMarkdown('\n\n---\n\n' + metaLines.join('  \n'));

		const raw = this.indexer.getRawNode(uid);
		if (raw && raw.columns && Object.keys(raw.columns).length > 0) {
			md.appendMarkdown('\n\n---\n\n**Columns**  \n');
			for (const col of Object.values(raw.columns)) {
				const type = col.data_type ? ` _${col.data_type}_` : '';
				const desc = col.description ? ` — ${col.description}` : '';
				md.appendMarkdown(`$(${SqlIcons.column}) \`${col.name}\`${type}${desc}  \n`);
			}
		}

		return new vscode.Hover(md);
	}

	private _hoverMacro(macroName: string): vscode.Hover | undefined {
		const macro = this.indexer.findMacroByName(macroName);
		if (!macro) return undefined;

		const md = this._md();
		const args = macro.arguments;
		const sig = args.length > 0
			? `(${args.map(a => a.name).join(', ')})`
			: '()';
		md.appendMarkdown(`$(${SqlIcons.macro}) **\`${macro.name}${sig}\`** — macro`);
		if (macro.description) {
			md.appendMarkdown(`\n\n${macro.description}`);
		}

		md.appendMarkdown(`\n\n---\n\n$(${SqlIcons.package}) \`${macro.packageName}\``);
		if (args.length > 0) {
			md.appendMarkdown('\n\n---\n\n**Arguments**  \n');
			for (const arg of args) {
				const type = arg.type ? ` _${arg.type}_` : '';
				const desc = arg.description ? ` — ${arg.description}` : '';
				md.appendMarkdown(`$(${SqlIcons.macroArg}) \`${arg.name}\`${type}${desc}  \n`);
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
		docUri: vscode.Uri,
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
				if (cte) return this._buildCteHover(cte, resolved.token, model, docUri);
				return null;
			}
			case 'table_alias': {
				// Alias definition in FROM/JOIN (e.g. the `o` in `FROM orders o`)
				const name = resolved.token.alias!;
				const cte = model.ctes.find(c =>
					c.name.toLowerCase() === resolved.token.name.toLowerCase()
					|| c.alias?.toLowerCase() === name.toLowerCase(),
				);
				if (cte) return this._buildCteHover(cte, resolved.token, model, docUri);
				return null;
			}
			case 'table_qualifier': {
				// Alias prefix of a column ref (e.g. the `o` in `o.order_id`)
				const alias = resolved.token.table!;
				const target = ParseService.resolveAlias(model, alias, resolved.token.line);
				if (!target) return null;
				switch (target.kind) {
					case 'cte': {
						const refTok = resolved.token.resolvedTableRef;
						const inner = refTok
							? this._buildCteHover(target.cte, refTok, model, docUri)
							: this._buildAliasHover(alias, target.cte.columns, docUri);
						return this._wrapWithAliasHeader(alias, target.cte.name, inner);
					}
					case 'ref': {
						const inner = this._hoverRef(target.ref.model);
						if (!inner) return null;
						return this._wrapWithAliasHeader(alias, target.ref.model, inner);
					}
					case 'source': {
						const inner = this._hoverSource(target.source.sourceName, target.source.tableName);
						if (!inner) return null;
						return this._wrapWithAliasHeader(alias, `${target.source.sourceName}.${target.source.tableName}`, inner);
					}
				}
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
						return this._buildColumnHover(colToken.name, colToken.table, chain, model, docUri);
					}
					// Qualifier resolves to a known alias but its column list is unavailable.
					if (!cols && refTok) {
						const isCte = model.ctes.some(c => c.name.toLowerCase() === refTok.name.toLowerCase());
						if (!isCte) {
							// Direct external ref (ref() / source) in the same scope — show lineage
							const chain = ParseService.traceCteLineage(refTok, model);
							return this._buildColumnHover(colToken.name, colToken.table, chain, model, docUri);
						}
						// CTE defined in this file but column list not available (e.g. macro caller)
						const unavail = this._md();
						unavail.appendMarkdown(`**${colToken.table}** (alias for \`${refTok.name}\`)\n\n`);
						unavail.appendMarkdown('_Column list unavailable — `' + refTok.name + '` is not defined in this file._');
						return new vscode.Hover(unavail);
					}
					// Qualified column with no resolvedTableRef — qualifier not locally defined
					return null;
				}
				// Bare column (qualify-resolved) — resolvedTableRef tells us the exact source
				if (refTok) {
					const cols = ParseService.columnsForRef(refTok, model);
					if (cols && (cols.includes('*') || cols.some(c => c.toLowerCase() === colToken.name.toLowerCase()))) {
						const chain = ParseService.traceCteLineage(refTok, model);
						return this._buildColumnHover(colToken.name, refTok.alias ?? refTok.name, chain, model, docUri);
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
				return this._buildColumnHover(word, colTok.resolvedTableRef.alias ?? colTok.resolvedTableRef.name, chain, model, document.uri);
			}
		}

		return undefined;
	}

	private _wrapWithAliasHeader(alias: string, targetName: string, inner: vscode.Hover): vscode.Hover {
		const md = this._md();
		md.appendMarkdown(`$(${SqlIcons.tableAlias}) **\`${alias}\`** \u2014 alias for \`${targetName}\``);
		md.appendMarkdown('\n\n---\n\n');
		const raw = inner.contents as unknown as vscode.MarkdownString | vscode.MarkdownString[];
		const innerMd = Array.isArray(raw) ? raw[0] : raw;
		md.appendMarkdown(innerMd.value);
		return new vscode.Hover(md);
	}

	private _buildCteHover(
		cte: { name: string; line: number; endLine: number; columns: { name: string; line: number }[] },
		refToken: TableRefToken,
		model: DocumentModel,
		docUri: vscode.Uri,
	): vscode.Hover {
		const md = this._md();
		const cteLink = this._lineLink(docUri, cte.line, cte.name);
		md.appendMarkdown(`$(${SqlIcons.cte}) **${cteLink}** — CTE (${cte.columns.length} columns, lines ${cte.line + 1}–${cte.endLine + 1})`);

		const cteByName = new Map(model.ctes.map(c => [c.name.toLowerCase(), c]));
		const chain = ParseService.traceCteLineage(refToken, model);
		const upstream = chain.slice(1);
		if (upstream.length > 0) {
			md.appendMarkdown('\n\n---\n\n**Lineage**  \n');
			for (let i = 0; i < upstream.length; i++) {
				const indent = '&nbsp;&nbsp;'.repeat(i * 2);
				const arrow = i === 0 ? '' : `$(${SqlIcons.lineage}) `;
				const label = this._chainEntryLabel(upstream[i], cteByName, docUri);
				md.appendMarkdown(`${indent}${arrow}${label}  \n`);
			}
		}

		if (cte.columns.length > 0) {
			md.appendMarkdown('\n\n---\n\n**Columns**  \n');
			const display = cte.columns.slice(0, 30);
			for (const col of display) {
				const label = this._lineLink(docUri, col.line, col.name);
				md.appendMarkdown(`$(${SqlIcons.column}) ${label}  \n`);
			}
			if (cte.columns.length > 30) {
				md.appendMarkdown(`\n_...and ${cte.columns.length - 30} more_`);
			}
		}

		return new vscode.Hover(md);
	}

	private _buildColumnHover(
		column: string,
		alias?: string,
		chain?: string[],
		model?: DocumentModel,
		docUri?: vscode.Uri,
	): vscode.Hover {
		const md = this._md();
		md.appendMarkdown(`$(${SqlIcons.column}) **\`${column}\`** — column`);

		if (chain && chain.length > 0) {
			md.appendMarkdown('\n\n---\n\n**Lineage**  \n');
			const cteMap = new Map(model?.ctes.map(c => [c.name.toLowerCase(), c]) ?? []);
			for (let i = 0; i < chain.length; i++) {
				const indent = '&nbsp;&nbsp;'.repeat(i * 2);
				const arrow = i === 0 ? '' : `$(${SqlIcons.lineage}) `;
				const label = this._chainEntryLabel(chain[i], cteMap, docUri);
				md.appendMarkdown(`${indent}${arrow}${label}  \n`);
			}
		} else if (alias) {
			const cteMap = new Map(model?.ctes.map(c => [c.name.toLowerCase(), c]) ?? []);
			const label = this._chainEntryLabel(alias, cteMap, docUri);
			md.appendMarkdown(`\n\n---\n\n$(${SqlIcons.lineage}) ${label}`);
		}

		return new vscode.Hover(md);
	}

	private _buildAliasHover(alias: string, cols: { name: string; line: number }[], docUri?: vscode.Uri): vscode.Hover {
		const md = this._md();
		md.appendMarkdown(`$(${SqlIcons.tableAlias}) **\`${alias}\`** — alias (${cols.length} columns)`);

		if (cols.length > 0) {
			md.appendMarkdown('\n\n---\n\n');
			const display = cols.slice(0, 20);
			for (const col of display) {
				const label = docUri ? this._lineLink(docUri, col.line, col.name) : `\`${col.name}\``;
				md.appendMarkdown(`$(${SqlIcons.column}) ${label}  \n`);
			}
			if (cols.length > 20) {
				md.appendMarkdown(`\n_...and ${cols.length - 20} more_`);
			}
		}

		return new vscode.Hover(md);
	}
}


