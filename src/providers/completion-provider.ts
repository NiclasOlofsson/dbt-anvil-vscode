import * as vscode from 'vscode';
import type { BridgeRunner } from '../dbt/bridge-runner';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
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

	/**
	 * Per-model describe cache. Keyed by unique node ID (e.g. "model.jaffle_shop.stg_customers").
	 * Survives document edits — only cleared when the manifest reloads via invalidateDescribeCache().
	 */
	private _describeCache = new Map<string, string[]>();

	/** Called by the extension when the manifest is reloaded. */
	invalidateDescribeCache(): void {
		this._describeCache.clear();
		this._scopeCache.clear();
		this.logger.debug('Describe cache invalidated (manifest reloaded)');
	}

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly bridge?: BridgeRunner,
	) {}

	async provideCompletionItems(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
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
			return this._completeColumns(document, aliasMatch[1]);
		}

		return undefined;
	}

	// -----------------------------------------------------------------------
	// Column completions (alias.column)
	// -----------------------------------------------------------------------

	private async _completeColumns(
		document: vscode.TextDocument,
		alias: string,
	): Promise<vscode.CompletionItem[]> {
		try {
			const aliasMap = await this._getScopeAliases(document);
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

	private async _getScopeAliases(document: vscode.TextDocument): Promise<Record<string, string[]>> {
		const key = document.uri.toString();
		const cached = this._scopeCache.get(key);
		if (cached && cached.version === document.version) {
			this.logger.debug('Column scope: using cached aliases');
			return cached.aliases;
		}

		if (!this.bridge) return {};

		const { sql, refs } = stripJinja(document.getText(), this.indexer);
		if (!sql) return {};

		const schemaMapping = this.indexer.buildSchemaMapping();
		const adapterType = this.indexer.index?.adapterType ?? 'ansi';

		// Build a map of upstream compiled SQL for refs that have no YAML columns
		// in schema_mapping. The bridge uses this to derive column lists via
		// sqlglot without needing a live DB connection.
		// Prefer compiled_code (dbt compile), fall back to raw_code stripped of Jinja.
		// For each upstream ref that has no documented columns in schema_mapping,
		// call describe_table via the bridge (dbt show against the actual DB).
		// This mirrors the dbt-core-mcp approach and works without compiled_code.
		for (const [tableName, uniqueId] of refs) {
			// Check if this table is already in schema_mapping
			const alreadyMapped = Object.values(schemaMapping).some(db =>
				Object.values(db).some(schema => tableName.toLowerCase() in schema),
			);
			if (alreadyMapped) continue;

			// Determine if it's a source or model
			const node = this.indexer.getRawNode(uniqueId);
			const isSource = uniqueId.startsWith('source.');
			const modelName = node && 'name' in node ? node.name : tableName;
			const sourceName = node && 'source_name' in node ? node.source_name : undefined;

			const cached = this._describeCache.get(uniqueId);
			if (cached) {
				this.logger.debug(`describe_table: ${tableName} (cached) → [${cached.join(', ')}]`);
				const db = (schemaMapping['__described__'] ??= {});
				const schema = (db['__described__'] ??= {});
				schema[tableName.toLowerCase()] = Object.fromEntries(cached.map(c => [c, {}]));
				continue;
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
					this._describeCache.set(uniqueId, cols);
					const db = (schemaMapping['__described__'] ??= {});
					const schema = (db['__described__'] ??= {});
					schema[tableName.toLowerCase()] = Object.fromEntries(cols.map(c => [c, {}]));
				} else {
					this.logger.debug(`describe_table: ${tableName} → no columns returned`);
				}
			} catch (err) {
				this.logger.debug(`describe_table: ${tableName} failed — ${err}`);
			}
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
