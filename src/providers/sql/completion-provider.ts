import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import { isLinePositionInComment } from '../common/comment-utils';
import { DbtCompletionKind } from '../common/icons';

/**
 * Completions for ref(), source(), macros, columns, and CTE/table names
 * after FROM/JOIN inside Jinja SQL files.
 */
export class DbtCompletionProvider implements vscode.CompletionItemProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		_context: vscode.CompletionContext,
	): Promise<vscode.CompletionItem[] | undefined> {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.completion', true)) return undefined;
		const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

		// Skip comments
		if (isLinePositionInComment(document.lineAt(position.line).text, position.character)) return undefined;

		// Inside ref('...')
		if (/ref\(\s*['"][^'"]*$/.test(linePrefix)) {
			const items = this._completeRef();
			this.logger.trace(`Completion: ref() → ${items.length} models`);
			return items;
		}

		// Inside source('name', '...')  (second argument)
		const sourceSecond = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*$/;
		const sourceSecondMatch = sourceSecond.exec(linePrefix);
		if (sourceSecondMatch) {
			const items = this._completeSourceTable(sourceSecondMatch[1]);
			this.logger.trace(`Completion: source('${sourceSecondMatch[1]}', ...) → ${items.length} tables`);
			return items;
		}

		// Inside source('...')  (first argument)
		if (/source\(\s*['"][^'"]*$/.test(linePrefix)) {
			const items = this._completeSourceName();
			this.logger.debug(`Completion: source() → ${items.length} sources`);
			return items;
		}

		// Inside {{ ... }} — complete macro names
		if (/\{\{[^}]*$/.test(linePrefix) && !/(?:ref|source)\(\s*['"]/.test(linePrefix)) {
			const items = this._completeMacros();
			this.logger.debug(`Completion: macro → ${items.length} macros`);
			return items;
		}

		// FQN completion: FROM/JOIN followed by dotted path with trailing dot
		// e.g. "FROM catalog." or "FROM catalog.schema."
		const fqnTrailingDot = /\b(?:from|join|into|update|table)\s+([\w.]+)\.\s*$/i.exec(linePrefix);
		if (fqnTrailingDot) {
			const items = this._completeFqnParts(fqnTrailingDot[1]);
			this.logger.debug(`Completion: FQN after '${fqnTrailingDot[1]}.' → ${items.length} items`);
			return items;
		}

		// FQN completion: FROM/JOIN followed by dotted path with partial last segment
		// e.g. "FROM catalog.schema.partial" or "FROM catalog.partial"
		const fqnPartial = /\b(?:from|join|into|update|table)\s+([\w.]+)\.\w+$/i.exec(linePrefix);
		if (fqnPartial) {
			const items = this._completeFqnParts(fqnPartial[1]);
			this.logger.debug(`Completion: FQN partial under '${fqnPartial[1]}' → ${items.length} items`);
			return items;
		}

		// alias. — column completions
		const aliasMatch = /(\w+)\.\s*$/.exec(linePrefix);
		if (aliasMatch) {
			this.logger.debug(`Completion: column for alias '${aliasMatch[1]}'`);
			return this._completeColumns(document, aliasMatch[1], token);
		}

		// Bare word in SQL context — offer all in-scope columns merged from all aliases
		// Match after whitespace/open-paren with zero or more word chars (covers empty trigger)
		if (/(?:^|[\s,(])\w*$/.test(linePrefix)) {
			// Skip if inside an unclosed Jinja expression
			const insideJinja = /\{\{[^}]*$/.test(linePrefix) || /\{%[^%]*$/.test(linePrefix);
			// After a table keyword — offer CTE names and model names (plain name or start of FQN)
			const afterTableKeyword = /\b(?:from|join|into|update|table)\s+\w*$/i.test(linePrefix);
			if (!insideJinja && afterTableKeyword) {
				this.logger.debug('Completion: table/CTE after FROM/JOIN');
				return this._completeTables(document, token);
			}
			if (!insideJinja) {
				this.logger.debug('Completion: bare column word');
				return this._completeAllColumns(document, token);
			}
		}

		return undefined;
	}

	// -----------------------------------------------------------------------
	// Column completions (alias.column)
	// -----------------------------------------------------------------------

	private async _completeColumns(
		document: vscode.TextDocument,
		alias: string,
		token: vscode.CancellationToken,
	): Promise<vscode.CompletionItem[]> {
		try {
			const aliasMap = await this._getScopeAliases(document, token);
			const aliasKeys = Object.keys(aliasMap);
			this.logger.debug(`Column scope aliases: [${aliasKeys.join(', ')}]`);
			const cols = aliasMap[alias] ?? aliasMap[alias.toLowerCase()];
			if (!cols || cols.length === 0) {
				this.logger.debug(`No columns found for alias '${alias}'`);
				return [];
			}

			this.logger.debug(`Completion: ${cols.length} columns for '${alias}': [${cols.slice(0, 5).join(', ')}${cols.length > 5 ? ', ...' : ''}]`);
			return cols.map((col, i) => {
			const item = new vscode.CompletionItem(col, DbtCompletionKind.column);
				item.detail = `column of ${alias}`;
				item.sortText = String(i).padStart(4, '0');
				return item;
			});
		} catch (err) {
			this.logger.warn(`Column completion failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	private async _completeAllColumns(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.CompletionItem[]> {
		try {
			const aliasMap = await this._getScopeAliases(document, token);
			if (Object.keys(aliasMap).length === 0) return [];

			// Invert alias→cols to col→[alias,...] for deduplication across tables
			const colSources = new Map<string, string[]>();
			for (const [alias, cols] of Object.entries(aliasMap)) {
				for (const col of cols) {
					if (!colSources.has(col)) colSources.set(col, []);
					colSources.get(col)!.push(alias);
				}
			}

			this.logger.debug(`Bare column completions: ${colSources.size} unique columns from ${Object.keys(aliasMap).length} aliases`);

			let i = 0;
			return Array.from(colSources.entries()).map(([col, sources]) => {
				const item = new vscode.CompletionItem(col, DbtCompletionKind.column);
				item.detail = sources.length === 1 ? `column of ${sources[0]}` : sources.join(', ');
				item.sortText = String(i++).padStart(4, '0');
				return item;
			});
		} catch (err) {
			this.logger.warn(`Bare column completion failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	private async _getScopeAliases(document: vscode.TextDocument, _token: vscode.CancellationToken): Promise<Record<string, string[]>> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService.getDocumentModel(document, dialect);
		return model ? ParseService.resolveAliases(model) : {};
	}

	// -----------------------------------------------------------------------
	// Table / CTE completions (after FROM / JOIN)
	// -----------------------------------------------------------------------

	private async _completeTables(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<vscode.CompletionItem[]> {
		const items: vscode.CompletionItem[] = [];
		let sortIndex = 0;

		// CTE names from ParseService (highest priority)
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService.getDocumentModel(document, dialect);
		if (token.isCancellationRequested) return [];
		if (model) {
			for (const cte of model.ctes) {
				const item = new vscode.CompletionItem(cte.name, DbtCompletionKind.cte);
				item.detail = `CTE (${cte.columns.length} columns)`;
				item.sortText = String(sortIndex++).padStart(4, '0');
				items.push(item);
			}
		}

		// Model names from manifest (lower priority)
		const refItems = this._completeRef();
		for (const item of refItems) {
			item.sortText = String(sortIndex++).padStart(4, '0');
			items.push(item);
		}

		this.logger.debug(`Completion: ${items.length} tables/CTEs after FROM/JOIN`);
		return items;
	}

	// -----------------------------------------------------------------------
	// FQN (catalog.schema.table) completions
	// -----------------------------------------------------------------------

	/**
	 * Given a dotted prefix from a FROM/JOIN context (e.g. "catalog" or "catalog.schema"),
	 * return the next segment candidates: schemas when prefix is a catalog, or table names
	 * when prefix is "catalog.schema".
	 */
	private _completeFqnParts(prefix: string): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const parts = prefix.toLowerCase().split('.');
		const items: vscode.CompletionItem[] = [];

		if (parts.length === 1) {
			const segment = parts[0];

			// Offer schemas where this segment is the database (3-part FQN: catalog.schema.)
			const schemas = new Set<string>();
			for (const model of index.models.values()) {
				if (model.database?.toLowerCase() === segment && model.schema) {
					schemas.add(model.schema.toLowerCase());
				}
			}
			for (const source of index.sources.values()) {
				if (source.database?.toLowerCase() === segment && source.schema) {
					schemas.add(source.schema.toLowerCase());
				}
			}
			for (const schema of schemas) {
				const item = new vscode.CompletionItem(schema, DbtCompletionKind.sourceName);
				item.detail = `schema in ${segment}`;
				items.push(item);
			}

			// Also offer table names where this segment is the schema (2-part FQN: schema.table)
			for (const model of index.models.values()) {
				if (model.schema?.toLowerCase() === segment) {
					const item = new vscode.CompletionItem(model.name, DbtCompletionKind.modelRef);
					item.detail = `${model.materialisation} — ${model.packageName}`;
					items.push(item);
				}
			}
			for (const source of index.sources.values()) {
				if (source.schema?.toLowerCase() === segment) {
					const item = new vscode.CompletionItem(source.name, DbtCompletionKind.sourceTable);
					item.detail = source.sourceName;
					items.push(item);
				}
			}
		} else if (parts.length === 2) {
			// Offer table names matching database+schema (3-part FQN: catalog.schema.table)
			const [db, schema] = parts;
			for (const model of index.models.values()) {
				if (model.database?.toLowerCase() === db && model.schema?.toLowerCase() === schema) {
					const item = new vscode.CompletionItem(model.name, DbtCompletionKind.modelRef);
					item.detail = `${model.materialisation} — ${model.packageName}`;
					items.push(item);
				}
			}
			for (const source of index.sources.values()) {
				if (source.database?.toLowerCase() === db && source.schema?.toLowerCase() === schema) {
					const item = new vscode.CompletionItem(source.name, DbtCompletionKind.sourceTable);
					item.detail = source.sourceName;
					items.push(item);
				}
			}
		}

		return items;
	}

	// -----------------------------------------------------------------------
	// ref / source / macro completions
	// -----------------------------------------------------------------------

	private _completeRef(): vscode.CompletionItem[] {
		const index = this.indexer.index;
		if (!index) return [];

		const items: vscode.CompletionItem[] = [];
		const byName = new Map<string, typeof items>();

		for (const model of index.models.values()) {
			if (!byName.has(model.name)) {
				byName.set(model.name, []);
			}
			const item = new vscode.CompletionItem(model.name, DbtCompletionKind.modelRef);
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
			const item = new vscode.CompletionItem(name, DbtCompletionKind.sourceName);
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
				const item = new vscode.CompletionItem(source.name, DbtCompletionKind.sourceTable);
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
			const item = new vscode.CompletionItem(macro.name, DbtCompletionKind.macro);
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
