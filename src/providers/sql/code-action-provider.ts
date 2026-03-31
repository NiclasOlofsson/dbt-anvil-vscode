import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { DbtPathResolver } from '../../dbt/dbt-path-resolver';
import type { ILogger } from '../../types/logger';

/**
 * Quick-fix code actions for dbt SQL files.
 * - Unknown ref('model') → create model file
 * - Inline refs: replace {{ ref('x') }} / {{ source('s','t') }} with relation name (ad-hoc only)
 * - Restore refs: replace relation names back to {{ ref() }} / {{ source() }} (ad-hoc only)
 */
export class SqlCodeActionProvider implements vscode.CodeActionProvider {
	static readonly providedCodeActionKinds = [
		vscode.CodeActionKind.QuickFix,
		vscode.CodeActionKind.Refactor,
	];

	private _pathResolver?: DbtPathResolver;

	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
	) {}

	setPathResolver(resolver: DbtPathResolver): void {
		this._pathResolver = resolver;
	}

	provideCodeActions(
		document: vscode.TextDocument,
		range: vscode.Range | vscode.Selection,
		_context: vscode.CodeActionContext,
		_token: vscode.CancellationToken,
	): vscode.CodeAction[] {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.sql.codeActions', true)) return [];

		const actions: vscode.CodeAction[] = [];
		const line = document.lineAt(range.start.line).text;

		// Check for ref('model_name') where model doesn't exist
		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const modelName = match[1];
			const models = this.indexer.findModelsByName(modelName);
			if (models.length === 0) {
				const action = new vscode.CodeAction(
					`Create model '${modelName}.sql'`,
					vscode.CodeActionKind.QuickFix,
				);
				action.command = {
					title: `Create ${modelName}.sql`,
					command: 'dbt-studio.createModelFile',
					arguments: [modelName],
				};
				action.isPreferred = true;
				actions.push(action);
				this.logger.debug(`CodeAction: offering to create model '${modelName}'`);
			}
		}

		// Inline/restore ref actions — ad-hoc SQL files only
		const category = this._pathResolver?.classifyFile(document.fileName);
		const isAdHoc = !category || (category !== 'model' && category !== 'seed' && category !== 'snapshot');
		if (isAdHoc) {
			const text = document.getText();
			const cursorChar = range.start.character;
			const lineText = document.lineAt(range.start.line).text;
			const lineOffset = document.offsetAt(new vscode.Position(range.start.line, 0));

			// Per-token: inline a single {{ ref() }} or {{ source() }} under cursor
			const macroRe = /\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}|\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g;
			let m: RegExpExecArray | null;
			while ((m = macroRe.exec(lineText)) !== null) {
				if (cursorChar >= m.index && cursorChar <= m.index + m[0].length) {
					let replacement: string | undefined;
					if (m[1]) {
						const models = this.indexer.findModelsByName(m[1]);
						if (models.length > 0) replacement = this._modelRelationName(models[0].uniqueId);
					} else if (m[2] && m[3]) {
						const found = this.indexer.findSourceByKey(m[2], m[3]);
						if (found) replacement = this._sourceRelationName(found.uid);
					}
					if (replacement) {
						const tokenAction = new vscode.CodeAction(`Inline to '${replacement}'`, vscode.CodeActionKind.Refactor);
						tokenAction.edit = new vscode.WorkspaceEdit();
						const start = document.positionAt(lineOffset + m.index);
						const end = document.positionAt(lineOffset + m.index + m[0].length);
						tokenAction.edit.replace(document.uri, new vscode.Range(start, end), replacement);
						tokenAction.isPreferred = true;
						actions.push(tokenAction);
					}
					break;
				}
			}

			// Per-token: restore a single relation name under cursor
			if (this.indexer.index) {
				const allRelations: Array<{ rel: string; macro: string }> = [];
				for (const model of this.indexer.index.models.values()) {
					const rel = this._modelRelationName(model.uniqueId);
					if (rel) allRelations.push({ rel, macro: `{{ ref('${model.name}') }}` });
				}
				for (const source of this.indexer.index.sources.values()) {
					const rel = this._sourceRelationName(source.uniqueId);
					if (rel) allRelations.push({ rel, macro: `{{ source('${source.sourceName}', '${source.name}') }}` });
				}
				allRelations.sort((a, b) => b.rel.length - a.rel.length);

				for (const { rel, macro } of allRelations) {
					const idx = lineText.indexOf(rel);
					if (idx !== -1 && cursorChar >= idx && cursorChar <= idx + rel.length) {
						const tokenAction = new vscode.CodeAction(`Restore to '${macro}'`, vscode.CodeActionKind.Refactor);
						tokenAction.edit = new vscode.WorkspaceEdit();
						const start = document.positionAt(lineOffset + idx);
						const end = document.positionAt(lineOffset + idx + rel.length);
						tokenAction.edit.replace(document.uri, new vscode.Range(start, end), macro);
						actions.push(tokenAction);
						break;
					}
				}
			}

			// Document-wide actions
			if (this._hasRefs(text)) {
				const inlineAction = new vscode.CodeAction(
					'Inline all refs and sources in file',
					vscode.CodeActionKind.Refactor,
				);
				inlineAction.command = {
					title: 'Inline refs and sources',
					command: 'dbt-studio.inlineRefs',
					arguments: [document.uri],
				};
				actions.push(inlineAction);
			}

			if (this._hasRelationNames(text)) {
				const restoreAction = new vscode.CodeAction(
					'Restore all refs and sources in file',
					vscode.CodeActionKind.Refactor,
				);
				restoreAction.command = {
					title: 'Restore refs and sources',
					command: 'dbt-studio.restoreRefs',
					arguments: [document.uri],
				};
				actions.push(restoreAction);
			}
		}

		return actions;
	}

	private _hasRefs(text: string): boolean {
		return /\{\{\s*(?:ref|source)\s*\(/.test(text);
	}

	private _hasRelationNames(text: string): boolean {
		const index = this.indexer.index;
		if (!index) return false;
		for (const model of index.models.values()) {
			const rel = this._modelRelationName(model.uniqueId);
			if (rel && text.includes(rel)) return true;
		}
		for (const source of index.sources.values()) {
			const rel = this._sourceRelationName(source.uniqueId);
			if (rel && text.includes(rel)) return true;
		}
		return false;
	}

	/** Build the fully-qualified relation name for a model node. */
	private _modelRelationName(uniqueId: string): string | undefined {
		const node = this.indexer.getRawNode(uniqueId);
		if (!node || !('schema' in node)) return undefined;
		const parts: string[] = [];
		if (node.database) parts.push(node.database);
		if (node.schema) parts.push(node.schema);
		parts.push((node as { alias?: string; name: string }).alias ?? node.name);
		return parts.join('.');
	}

	/** Build the fully-qualified relation name for a source node. */
	private _sourceRelationName(uniqueId: string): string | undefined {
		const node = this.indexer.getRawNode(uniqueId);
		if (!node || !('source_name' in node)) return undefined;
		const src = node as { database?: string; schema: string; name: string };
		const parts: string[] = [];
		if (src.database) parts.push(src.database);
		parts.push(src.schema);
		parts.push(src.name);
		return parts.join('.');
	}

	/** Inline all {{ ref() }} and {{ source() }} macros in text → relation names. */
	inlineRefs(text: string): string {
		// Replace {{ ref('model') }}
		text = text.replace(/\{\{\s*ref\(\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, (_full, name) => {
			const models = this.indexer.findModelsByName(name);
			if (models.length === 0) return _full;
			const rel = this._modelRelationName(models[0].uniqueId);
			return rel ?? _full;
		});

		// Replace {{ source('source_name', 'table_name') }}
		text = text.replace(/\{\{\s*source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)\s*\}\}/g, (_full, sourceName, tableName) => {
			const found = this.indexer.findSourceByKey(sourceName, tableName);
			if (!found) return _full;
			const rel = this._sourceRelationName(found.uid);
			return rel ?? _full;
		});

		return text;
	}

	/** Restore relation names back to {{ ref() }} / {{ source() }} macros. */
	restoreRefs(text: string): string {
		const index = this.indexer.index;
		if (!index) return text;

		// Build replacement map: relation name → macro, longest first to avoid partial matches
		const replacements: Array<{ rel: string; macro: string }> = [];

		for (const model of index.models.values()) {
			const rel = this._modelRelationName(model.uniqueId);
			if (rel) replacements.push({ rel, macro: `{{ ref('${model.name}') }}` });
		}
		for (const source of index.sources.values()) {
			const rel = this._sourceRelationName(source.uniqueId);
			if (rel) replacements.push({ rel, macro: `{{ source('${source.sourceName}', '${source.name}') }}` });
		}

		// Sort longest relation name first to avoid partial substitution
		replacements.sort((a, b) => b.rel.length - a.rel.length);

		for (const { rel, macro } of replacements) {
			// Word-boundary aware: only replace when preceded/followed by whitespace, comma, paren, or start/end
			const escaped = rel.replace(/\./g, '\\.').replace(/`/g, '\\`');
			text = text.replace(new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`, 'g'), macro);
		}

		return text;
	}
}
