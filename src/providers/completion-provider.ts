import * as vscode from 'vscode';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestWatcher } from '../indexing/manifest-watcher';
import type { ILogger } from '../types/logger';
import { stripJinja } from './jinja-utils';

/**
 * Completions for ref(), source(), macros, and columns inside Jinja SQL files.
 */
export class DbtCompletionProvider implements vscode.CompletionItemProvider {
	/**
	 * Per-document cache of alias → column names from the bridge.
	 * Keyed by document URI, invalidated when the document version changes.
	 */
	private _scopeCache = new Map<string, { version: number; aliases: Record<string, string[]> }>();
	/** In-flight promises keyed by `uri@version` — prevents duplicate bridge calls for the same document version. */
	private _scopeInFlight = new Map<string, Promise<Record<string, string[]>>>();

	/** Called by the extension when the manifest is reloaded. */
	invalidateScopeCache(): void {
		this._scopeCache.clear();
		this.logger.debug('Scope cache invalidated (manifest reloaded)');
	}

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly bridge?: BridgeRunner,
		private readonly watcher?: ManifestWatcher,
	) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
		_context: vscode.CompletionContext,
	): Promise<vscode.CompletionItem[] | undefined> {
		const linePrefix = document.lineAt(position.line).text.substring(0, position.character);

		// Inside ref('...')
		if (/ref\(\s*['"][^'"]*$/.test(linePrefix)) {
			const items = this._completeRef();
			this.logger.debug(`Completion: ref() → ${items.length} models`);
			return items;
		}

		// Inside source('name', '...')  (second argument)
		const sourceSecond = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"][^'"]*$/;
		const sourceSecondMatch = sourceSecond.exec(linePrefix);
		if (sourceSecondMatch) {
			const items = this._completeSourceTable(sourceSecondMatch[1]);
			this.logger.debug(`Completion: source('${sourceSecondMatch[1]}', ...) → ${items.length} tables`);
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

		// alias. — column completions (requires bridge)
		const aliasMatch = /(\w+)\.\s*$/.exec(linePrefix);
		if (aliasMatch && this.bridge) {
			this.logger.debug(`Completion: column for alias '${aliasMatch[1]}'`);
			return this._completeColumns(document, aliasMatch[1], token);
		}

		// Bare word in SQL context — offer all in-scope columns merged from all aliases
		// Match after whitespace/open-paren with zero or more word chars (covers empty trigger)
		if (this.bridge && /(?:^|[\s,(])\w*$/.test(linePrefix)) {
			// Skip if inside an unclosed Jinja expression
			const insideJinja = /\{\{[^}]*$/.test(linePrefix) || /\{%[^%]*$/.test(linePrefix);
			// Skip if after a keyword where a table/relation name is expected
			const afterTableKeyword = /\b(?:from|join|into|update|table)\s+\w*$/i.test(linePrefix);
			if (!insideJinja && !afterTableKeyword) {
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
				const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
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
				const item = new vscode.CompletionItem(col, vscode.CompletionItemKind.Field);
				item.detail = sources.length === 1 ? `column of ${sources[0]}` : sources.join(', ');
				item.sortText = String(i++).padStart(4, '0');
				return item;
			});
		} catch (err) {
			this.logger.warn(`Bare column completion failed: ${err instanceof Error ? err.message : String(err)}`);
			return [];
		}
	}

	private async _getScopeAliases(document: vscode.TextDocument, token: vscode.CancellationToken): Promise<Record<string, string[]>> {
		const key = document.uri.toString();
		const cached = this._scopeCache.get(key);
		if (cached && cached.version === document.version) {
			this.logger.debug('Column scope: using cached aliases');
			return cached.aliases;
		}

		if (!this.bridge) return {};

		// Deduplicate concurrent calls for the same document version.
		// VS Code can call provideCompletionItems multiple times for a single trigger.
		const inflightKey = `${key}@${document.version}`;
		const inflight = this._scopeInFlight.get(inflightKey);
		if (inflight) {
			this.logger.debug('Column scope: awaiting in-flight request');
			return inflight;
		}

		const promise = this._resolveScopeAliases(document, key, token);
		this._scopeInFlight.set(inflightKey, promise);
		try {
			return await promise;
		} finally {
			this._scopeInFlight.delete(inflightKey);
		}
	}

	private async _resolveScopeAliases(document: vscode.TextDocument, key: string, token: vscode.CancellationToken): Promise<Record<string, string[]>> {
		if (!this.bridge) return {};

		const { sql, refs } = stripJinja(document.getText(), this.indexer);
		if (!sql) return {};

		const schemaMapping = this.indexer.buildSchemaMapping();
		const adapterType = this.indexer.index?.adapterType ?? 'ansi';

		// Build a map of upstream compiled SQL for refs that have no YAML columns
		// in schema_mapping. The bridge uses this to derive column lists via
		// sqlglot without needing a live DB connection.
		// Prefer compiled_code (dbt compile), fall back to raw_code stripped of Jinja.
		// For each upstream ref, call describe_table via the bridge (dbt show against
		// the actual DB) — warehouse is the source of truth. Column store cache
		// short-circuits repeat calls. YAML columns in schemaMapping act as the
		// implicit fallback: if describe returns nothing (model not yet materialized),
		// sqlglot falls back to whatever YAML documented.
		// Suppress the manifest watcher during bridge calls — dbt show rewrites
		// manifest.json as a side effect but doesn't change model definitions.
		this.watcher?.suppress();
		try {
			for (const [tableName, uniqueId] of refs) {
				// Determine if it's a source or model
				const node = this.indexer.getRawNode(uniqueId);
				const isSource = uniqueId.startsWith('source.');
				const modelName = node && 'name' in node ? node.name : tableName;
				const sourceName = node && 'source_name' in node ? node.source_name : undefined;

				const cached = this.indexer.getColumns(uniqueId);
				if (cached) {
					this.logger.debug(`describe_table: ${tableName} (cached) → [${cached.join(', ')}]`);
					const db = (schemaMapping['__described__'] ??= {});
					const schema = (db['__described__'] ??= {});
					schema[tableName.toLowerCase()] = Object.fromEntries(cached.map(c => [c, {}]));
					continue;
				}

				if (token.isCancellationRequested) {
					this.logger.debug('Column scope: cancelled before describe');
					return {};
				}
				this.logger.debug(`describe_table: ${tableName} (${uniqueId})`);
				try {
					const descResult = await this.bridge.invokeRaw(
						isSource
							? { describe_table: true, name: modelName, source_name: sourceName }
							: { describe_table: true, name: modelName },
					);
					const descData = descResult.data as Record<string, unknown> | undefined;
					const cols = descData?.columns as string[] | undefined;
					if (cols && cols.length > 0) {
						this.logger.debug(`describe_table: ${tableName} → [${cols.join(', ')}]`);
						this.indexer.setColumns(uniqueId, cols);
						const db = (schemaMapping['__described__'] ??= {});
						const schema = (db['__described__'] ??= {});
						schema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c, {}]));
						continue;  // columns resolved — YAML in schemaMapping is now the fallback for this ref only if describe had returned nothing
					}
					this.logger.debug(`describe_table: ${tableName} → no columns returned, falling back to YAML`);
				} catch (err) {
					this.logger.debug(`describe_table: ${tableName} failed — ${err}`);
				}
			}

			if (token.isCancellationRequested) {
				this.logger.debug('Column scope: cancelled before get_scope_columns');
				return {};
			}
			const payload: Record<string, unknown> = {
				get_scope_columns: true,
				sql,
				dialect: adapterType,
				schema_mapping: schemaMapping,
			};

			const result = await this.bridge.invokeRaw(payload);

			const data = result.data as Record<string, unknown> | undefined;
			const aliases: Record<string, string[]> = (data?.aliases as Record<string, string[]>) ?? {};

			this._scopeCache.set(key, { version: document.version, aliases });
			return aliases;
		} finally {
			this.watcher?.resume();
		}
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
			const item = new vscode.CompletionItem(model.name, vscode.CompletionItemKind.Reference);
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
			const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Module);
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
				const item = new vscode.CompletionItem(source.name, vscode.CompletionItemKind.Field);
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
			const item = new vscode.CompletionItem(macro.name, vscode.CompletionItemKind.Function);
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
