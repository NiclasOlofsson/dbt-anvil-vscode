import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import type { Completion } from '../../ftl/sqllens/api';
import { isLinePositionInComment } from '../common/comment-utils';
import { DbtCompletionKind } from '../common/icons';
import { isCursorInsideOpenJinjaTag } from './jinja-cursor';

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
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.completion', true)) return undefined;
		const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

		// Skip comments
		if (isLinePositionInComment(document.lineAt(position.line).text, position.character)) return undefined;

		// ONE sqllens call at the CARET. Since sqllens 1.4.0 the caret token is the token being
		// typed, so a single offset serves both the jinja slots and the SQL walk — no
		// pre-detection of which world we're in, and no word-start anchoring.
		const cursorOffset = document.offsetAt(position);
		const docText = document.getText();
		const candidates = this.parseService.completeAt(docText, cursorOffset);

		// A jinja call slot: sqllens located it (`jinjaSlotAt`), our provider named it
		// (`templateCandidates` → ref models / source names + that source's tables / macros +
		// the `ref`/`source` builtins). This replaces the old ref()/source()/macro line-prefix
		// regexes — the parse decides the slot now, not a backwards scan of the line.
		const templates = candidates.filter(c => c.kind === 'template');
		if (templates.length > 0) {
			this.logger.debug(`Completion: jinja slot → ${templates.length} dbt names`);
			return templates.map(c => {
				const item = new vscode.CompletionItem(c.label, DbtCompletionKind.modelRef);
				if (c.detail) item.detail = c.detail;
				return item;
			});
		}

		// Inside a tag but not at a call slot (`{% if x %}`, a comment tag): sqllens offers
		// nothing there and neither should we — SQL completion must not leak into a tag.
		if (isCursorInsideOpenJinjaTag(docText, cursorOffset)) return undefined;

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
			// Skip if inside an unclosed jinja expression/block (multi-line aware)
			const insideJinja = isCursorInsideOpenJinjaTag(docText, cursorOffset);
			// After a table keyword — offer CTE names and model names (plain name or start of FQN)
			const afterTableKeyword = /\b(?:from|join|into|update|table)\s+\w*$/i.test(linePrefix);
			if (!insideJinja && afterTableKeyword) {
				this.logger.debug('Completion: table/CTE after FROM/JOIN');
				return this._completeTables(document, token);
			}
			if (!insideJinja) {
				this.logger.debug('Completion: bare word (columns + SQL functions/keywords)');
				const columns = await this._completeAllColumns(document, token);
				return [...columns, ...this._sqlWordItems(candidates)];
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
		const model = await this.parseService.getDocumentModel(document);
		return model ? ParseService.resolveAliases(model) : {};
	}

	// -----------------------------------------------------------------------
	// SQL function / keyword completions (dialect-aware, from sqllens)
	// -----------------------------------------------------------------------

	/**
	 * The SQL function + keyword half of sqllens's candidates, as editor items. The engine
	 * self-gates on caret context: functions surface only at a value/expression slot, and
	 * keywords are the grammar candidates reachable at the caret — so this needs no
	 * per-dialect list of ours. Its column/table candidates are dropped: the
	 * manifest/describe-backed ones we produce are richer. Sorted after columns (columns
	 * first, then functions, then keywords).
	 */
	private _sqlWordItems(candidates: readonly Completion[]): vscode.CompletionItem[] {
		const items: vscode.CompletionItem[] = [];
		for (const c of candidates) {
			if (c.kind === 'function') {
				const item = new vscode.CompletionItem(c.label, DbtCompletionKind.sqlFunction);
				item.detail = c.detail ?? 'SQL function';
				item.insertText = new vscode.SnippetString(`${c.label}($0)`);
				item.sortText = `8_${c.label}`;
				items.push(item);
			} else if (c.kind === 'keyword') {
				const item = new vscode.CompletionItem(c.label, DbtCompletionKind.keyword);
				if (c.detail) item.detail = c.detail;
				item.sortText = `9_${c.label}`;
				items.push(item);
			}
		}
		this.logger.trace(`Completion: ${items.length} SQL functions/keywords`);
		return items;
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
		const model = await this.parseService.getDocumentModel(document);
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

}
