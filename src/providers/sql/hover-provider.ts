import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import type { DocumentModel } from '../../services/parse-service';
import type { Sym } from '../../ftl/sqllens/api';
import { isLinePositionInComment } from '../common/comment-utils';
import { isSqlKeywordOrFunction } from './sql-words';
import type { DialectSymbols } from '../../ftl/sql-tokens';
import { resolvePositionContext } from './position-context';
import { relationForAlias } from './sym-spans';
import { DbtMaterializationIcons, SqlIcons } from '../common/icons';

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
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.hover', true)) return undefined;
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return undefined;

		const model = await this.parseService.getDocumentModel(document);
		if (token.isCancellationRequested || !model) return undefined;

		const ctx = resolvePositionContext(model, position, document.offsetAt(position));

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
		if (ctx?.kind === 'function') {
			const hover = this._hoverFunction(ctx.fn.name);
			this.logger.trace(`Hover: function('${ctx.fn.name}') → ${hover ? 'found' : 'not found'}`);
			return hover;
		}
		if (ctx?.kind === 'sym' && ctx.sym.kind === 'function') {
			// A direct call by warehouse name (`schema.fn(...)`) that matches an indexed dbt function.
			const direct = this._hoverFunction(ctx.sym.name.split('.').pop()!);
			if (direct) return direct;
		}
		if (ctx?.kind === 'sym') {
			// null = AST recognised the symbol but has nothing to show; suppress fallback
			const hover = this._hoverResolvedToken(model, ctx.sym, ctx.partIndex, token, document.uri);
			if (hover !== undefined) return hover ?? undefined;
			return undefined;
		}

		// No token match — try bare-word column fallback
		const dialectSymbols = await this.parseService.getDialectSymbols();
		return this._hoverColumnFallback(document, position, line, model, token, dialectSymbols);
	}

	private _md(): vscode.MarkdownString {
		const md = new vscode.MarkdownString();
		md.supportThemeIcons = true;
		md.isTrusted = { enabledCommands: ['dbt-anvil.goToLine'] };
		return md;
	}

	private _lineLink(uri: vscode.Uri, line: number, label: string): string {
		const args = encodeURIComponent(JSON.stringify({ uri: uri.toString(), line }));
		return `[\`${label}\`](command:dbt-anvil.goToLine?${args})`;
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

	private _hoverFunction(name: string): vscode.Hover | undefined {
		const fns = this.indexer.findFunctionsByName(name);
		if (fns.length === 0) return undefined;
		const fn = fns[0];

		const md = this._md();
		const sig = `(${fn.arguments.map(a => `${a.name} ${a.dataType}`).join(', ')})`;
		md.appendMarkdown(`$(${SqlIcons.function}) **\`${fn.name}${sig}\`** — function · _${fn.functionType}_ · returns _${fn.returns}_`);
		if (fn.description) {
			md.appendMarkdown(`\n\n${fn.description}`);
		}

		const metaLines: string[] = [
			`$(${SqlIcons.package}) \`${fn.packageName}\``,
			`$(${SqlIcons.file}) \`${fn.path}\``,
		];
		if (fn.schema) metaLines.push(`$(${SqlIcons.schema}) \`${fn.schema}\``);
		if (fn.tags.length > 0) {
			metaLines.push(`$(${SqlIcons.tag}) ${fn.tags.map(t => `\`${t}\``).join(' ')}`);
		}
		md.appendMarkdown('\n\n---\n\n' + metaLines.join('  \n'));

		if (fn.arguments.length > 0) {
			md.appendMarkdown('\n\n---\n\n**Arguments**  \n');
			for (const arg of fn.arguments) {
				const desc = arg.description ? ` — ${arg.description}` : '';
				md.appendMarkdown(`$(${SqlIcons.macroArg}) \`${arg.name}\` _${arg.dataType}_${desc}  \n`);
			}
		}

		return new vscode.Hover(md);
	}

	// ---- Sym-based hover (AST resolution already done by resolvePositionContext) ----

	// Returns:
	//   Hover  — show this tooltip
	//   null   — AST recognised the symbol but has nothing to show; suppress fallback
	private _hoverResolvedToken(
		model: DocumentModel,
		sym: Sym,
		partIndex: number | undefined,
		token: vscode.CancellationToken,
		docUri: vscode.Uri,
	): vscode.Hover | null | undefined {
		if (token.isCancellationRequested) return undefined;
		this.logger.trace(`Hover: sym kind='${sym.kind}' name='${sym.name}'`);

		// old 'table_ref' — table/CTE/subquery/lateral name in FROM/JOIN
		if (sym.kind === 'table' || sym.kind === 'cte' || sym.kind === 'subquery' || sym.kind === 'lateral') {
			const cte = ParseService.cteForRef(sym, model);
			if (cte) return this._buildCteHover(cte, sym, model, docUri);
			return null;
		}

		// old 'table_alias' — alias definition in FROM/JOIN (e.g. the `o` in `FROM orders o`).
		// The old bridge resolved this against the SAME token as the table name itself; under
		// Sym the alias is its own symbol, so look up the relation it belongs to first.
		if (sym.kind === 'alias') {
			const relation = relationForAlias(sym, model.symbols ?? []);
			if (!relation) return null;
			const cte = ParseService.cteForRef(relation, model);
			if (cte) return this._buildCteHover(cte, relation, model, docUri);
			return null;
		}

		if (sym.kind !== 'column') return null;

		// old 'column_def' — declaration site (e.g. in a CTE select list) — nothing to hover
		if (sym.modifiers.includes('declaration')) return null;

		const resolved = sym.source;
		const isQualifierPart = sym.partSpans !== undefined
			&& partIndex !== undefined
			&& partIndex < sym.partSpans.length - 1;

		if (isQualifierPart) {
			// old 'table_qualifier' — alias prefix of a column ref (e.g. the `o` in `o.order_id`).
			// Use the resolved source directly — same as definition provider — to avoid
			// scoping problems in resolveAlias.
			const alias = sym.name.split('.').slice(0, -1).join('.');
			if (!resolved) return null;

			const cte = ParseService.cteForRef(resolved, model);
			if (cte) {
				const inner = this._buildCteHover(cte, resolved, model, docUri);
				return this._wrapWithAliasHeader(alias, cte.name, inner);
			}

			const ref = model.refs.find(r => r.model.toLowerCase() === resolved.name.toLowerCase());
			if (ref) {
				const inner = this._hoverRef(ref.model);
				if (!inner) {
					const md = this._md();
					md.appendMarkdown(`$(${SqlIcons.tableAlias}) **\`${alias}\`** — alias for \`${ref.model}\``);
					return new vscode.Hover(md);
				}
				return this._wrapWithAliasHeader(alias, ref.model, inner);
			}

			const src = model.sources.find(s => s.tableName.toLowerCase() === resolved.name.toLowerCase());
			if (src) {
				const inner = this._hoverSource(src.sourceName, src.tableName);
				if (!inner) {
					const md = this._md();
					md.appendMarkdown(`$(${SqlIcons.tableAlias}) **\`${alias}\`** — alias for \`${src.sourceName}.${src.tableName}\``);
					return new vscode.Hover(md);
				}
				return this._wrapWithAliasHeader(alias, `${src.sourceName}.${src.tableName}`, inner);
			}

			return null;
		}

		// old 'column' — column reference — show column info with source
		const bareName = sym.name.split('.').pop()!;
		if (sym.name.includes('.')) {
			// Qualified column. Post-Phase-0, the resolved source's canonical alias/name IS
			// the display qualifier (matches the old bridge's `.table`, which was upgraded to
			// this same value whenever resolution succeeded); fall back to the raw written
			// qualifier text only when unresolved.
			const displayQualifier = resolved
				? (resolved.alias?.name ?? resolved.name)
				: sym.name.split('.').slice(0, -1).join('.');
			const cols = resolved ? ParseService.columnsForRef(resolved, model) : undefined;
			this.logger.trace(`Hover: column '${displayQualifier}.${bareName}' — resolved: ${resolved?.name ?? 'none'}, cols: ${cols ? `[${cols.join(', ')}]` : 'none'}`);
			if (cols && (cols.includes('*') || cols.some(c => c.toLowerCase() === bareName.toLowerCase()))) {
				const chain = ParseService.traceCteLineage(resolved!, model);
				return this._buildColumnHover(bareName, displayQualifier, chain, model, docUri);
			}
			// Qualifier resolves to a known alias but its column list is unavailable.
			if (!cols && resolved) {
				const isCte = model.ctes.some(c => c.name.toLowerCase() === resolved.name.toLowerCase());
				if (!isCte) {
					// Direct external ref (ref() / source) in the same scope — show lineage
					const chain = ParseService.traceCteLineage(resolved, model);
					return this._buildColumnHover(bareName, displayQualifier, chain, model, docUri);
				}
				// CTE defined in this file but column list not available (e.g. macro caller)
				const unavail = this._md();
				unavail.appendMarkdown(`**${displayQualifier}** (alias for \`${resolved.name}\`)\n\n`);
				unavail.appendMarkdown('_Column list unavailable — `' + resolved.name + '` is not defined in this file._');
				return new vscode.Hover(unavail);
			}
			// Qualified column with no resolved source — qualifier not locally defined
			return null;
		}
		// Bare column (qualify-resolved) — the resolved source tells us the exact source
		if (resolved) {
			const cols = ParseService.columnsForRef(resolved, model);
			if (cols && (cols.includes('*') || cols.some(c => c.toLowerCase() === bareName.toLowerCase()))) {
				const chain = ParseService.traceCteLineage(resolved, model);
				return this._buildColumnHover(bareName, resolved.alias?.name ?? resolved.name, chain, model, docUri);
			}
		}
		return null;
	}

	// ---- Fallback column hover (no sym match) ----

	private _hoverColumnFallback(
		document: vscode.TextDocument,
		position: vscode.Position,
		line: string,
		model: DocumentModel,
		token: vscode.CancellationToken,
		dialectSymbols: DialectSymbols | undefined,
	): vscode.Hover | undefined {
		if (token.isCancellationRequested) return undefined;
		const prefix = line.substring(0, position.character);
		if (/\{\{[^}]*$/.test(prefix) || /\{%[^%]*$/.test(prefix)) return undefined;

		const wordRange = document.getWordRangeAtPosition(position, /[a-zA-Z_]\w*/);
		if (!wordRange) return undefined;
		const word = document.getText(wordRange);
		if (isSqlKeywordOrFunction(word, dialectSymbols)) return undefined;

		// Find the column Sym at this position, use its bound source if available
		const colSym = (model.symbols ?? []).find(s =>
			s.kind === 'column' && s.modifiers.includes('reference')
			&& s.name.split('.').pop()!.toLowerCase() === word.toLowerCase()
			&& (s.span.line - 1) === position.line,
		);
		const resolved = colSym?.source;
		if (resolved) {
			const cols = ParseService.columnsForRef(resolved, model);
			if (cols && (cols.includes('*') || cols.some(c => c.toLowerCase() === word.toLowerCase()))) {
				const chain = ParseService.traceCteLineage(resolved, model);
				return this._buildColumnHover(word, resolved.alias?.name ?? resolved.name, chain, model, document.uri);
			}
		}

		return undefined;
	}

	private _wrapWithAliasHeader(alias: string, targetName: string, inner: vscode.Hover): vscode.Hover {
		const md = this._md();
		md.appendMarkdown(`$(${SqlIcons.tableAlias}) **\`${alias}\`** — alias for \`${targetName}\``);
		md.appendMarkdown('\n\n---\n\n');
		const raw = inner.contents as unknown as vscode.MarkdownString | vscode.MarkdownString[];
		const innerMd = Array.isArray(raw) ? raw[0] : raw;
		md.appendMarkdown(innerMd.value);
		return new vscode.Hover(md);
	}

	private _buildCteHover(
		cte: { name: string; line: number; endLine: number; columns: { name: string; line: number }[] },
		refSym: Sym,
		model: DocumentModel,
		docUri: vscode.Uri,
	): vscode.Hover {
		const md = this._md();
		const cteLink = this._lineLink(docUri, cte.line, cte.name);
		md.appendMarkdown(`$(${SqlIcons.cte}) **${cteLink}** — CTE (${cte.columns.length} columns, lines ${cte.line + 1}–${cte.endLine + 1})`);

		const cteByName = new Map(model.ctes.map(c => [c.name.toLowerCase(), c]));
		const chain = ParseService.traceCteLineage(refSym, model);
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
