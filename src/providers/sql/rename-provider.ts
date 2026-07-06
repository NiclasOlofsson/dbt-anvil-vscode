import * as vscode from 'vscode';
import type { ManifestIndexer, ManifestIndex } from '../../indexing/manifest-indexer';
import type { ManifestLoader } from '../../dbt/manifest-loader';
import type { ILogger } from '../../types/logger';
import { ParseService } from '../../services/parse-service';
import type { DocumentModel } from '../../services/parse-service';
import type { Sym } from '../../ftl/sqllens/api';
import { buildInFileRenameEdits } from './rename-edits';
import { isRelationSym, nameRangeOf, qualifierRangeOf, rangeOfSpan, relationNameRangeOf } from './sym-spans';

/**
 * Rename ref('model') across the workspace using the manifest dependency graph.
 * Only touches files the graph identifies as dependents — no workspace-wide scan.
 * Also updates schema.yml model name entries and renames the .sql file.
 */
export class DbtRenameProvider implements vscode.RenameProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
		private readonly parseService?: ParseService,
	) {}

	async prepareRename(
		document: vscode.TextDocument,
		position: vscode.Position,
		_token: vscode.CancellationToken,
	): Promise<vscode.Range | { range: vscode.Range; placeholder: string }> {
		const line = document.lineAt(position.line).text;

		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refRe.exec(line)) !== null) {
			const nameStart = match.index + match[0].indexOf(match[1]);
			const nameEnd = nameStart + match[1].length;
			if (position.character >= nameStart && position.character <= nameEnd) {
				const range = new vscode.Range(
					new vscode.Position(position.line, nameStart),
					new vscode.Position(position.line, nameEnd),
				);
				return { range, placeholder: match[1] };
			}
		}

		if (this.parseService) {
			const model = await this.parseService.getDocumentModel(document);
			if (model) {
				const sym = ParseService.symAtPosition(model, position.line, position.character);
				if (sym) {
					const partIndex = ParseService.partIndexAtPosition(sym, position.line, position.character);
					const r = this._tokenRenameRange(sym, partIndex, model);
					if (r) return r;
				}
			}
		}

		throw new Error('Cannot rename this element — place cursor on a renameable symbol.');
	}

	async provideRenameEdits(
		document: vscode.TextDocument,
		position: vscode.Position,
		newName: string,
		token: vscode.CancellationToken,
	): Promise<vscode.WorkspaceEdit | undefined> {
		if (!vscode.workspace.getConfiguration('dbt-anvil').get('providers.sql.rename', true)) return undefined;
		const line = document.lineAt(position.line).text;

		const refRe = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		let oldName: string | undefined;

		while ((match = refRe.exec(line)) !== null) {
			const nameStart = match.index + match[0].indexOf(match[1]);
			const nameEnd = nameStart + match[1].length;
			if (position.character >= nameStart && position.character <= nameEnd) {
				oldName = match[1];
				break;
			}
		}

		if (oldName) {
			const index = this.indexer.index;
			if (!index) return undefined;

			this.logger.info(`RenameProvider: renaming '${oldName}' → '${newName}'`);
			const edit = new vscode.WorkspaceEdit();
			const models = this.indexer.findModelsByName(oldName);

			const refPattern = new RegExp(`(ref\\(\\s*['"])${this._escapeRegex(oldName)}(['"]\\s*\\))`, 'g');

			for (const model of models) {
				// 1. Replace ref('old') → ref('new') in downstream dependents only
				const childIds = index.childMap.get(model.uniqueId) ?? [];
				const filePaths = this._resolveFilePaths(childIds, index);

				// Also include the model's own file (it may self-reference or we want to be thorough)
				if (model.path) {
					filePaths.add(model.path);
				}

				for (const filePath of filePaths) {
					if (token.isCancellationRequested) return undefined;
					await this._replaceInFile(vscode.Uri.file(filePath), refPattern, oldName, newName, edit);
				}

				// 2. Update schema.yml entry for this model's own YAML definition
				if (model.path) {
					await this._updateYamlModelName(model.path, oldName, newName, edit, token);
				}

				// 3. Rename the .sql file itself
				if (model.path) {
					const oldUri = vscode.Uri.file(model.path);
					const dir = model.path.replace(/[/\\][^/\\]+$/, '');
					const newUri = vscode.Uri.file(`${dir}/${newName}.sql`);
					edit.renameFile(oldUri, newUri);
				}
			}

			this.logger.info(`RenameProvider: created ${edit.entries().length} edit entries`);
			return edit;
		}

		// Sym-based in-file rename (column, alias, CTE name)
		if (this.parseService) {
			const docModel = await this.parseService.getDocumentModel(document);
			if (docModel) {
				const sym = ParseService.symAtPosition(docModel, position.line, position.character);
				if (sym) {
					const partIndex = ParseService.partIndexAtPosition(sym, position.line, position.character);
					return buildInFileRenameEdits(sym, partIndex, docModel, document.uri, newName);
				}
			}
		}

		return undefined;
	}

	/** Collect unique file paths from a list of node IDs. */
	private _resolveFilePaths(uniqueIds: string[], index: ManifestIndex): Set<string> {
		const paths = new Set<string>();
		for (const uid of uniqueIds) {
			const model = index.models.get(uid);
			if (model?.path) paths.add(model.path);
		}
		return paths;
	}

	/** Replace ref('oldName') with ref('newName') in a single file. */
	private async _replaceInFile(
		fileUri: vscode.Uri,
		pattern: RegExp,
		oldName: string,
		newName: string,
		edit: vscode.WorkspaceEdit,
	): Promise<void> {
		try {
			const doc = await vscode.workspace.openTextDocument(fileUri);
			const text = doc.getText();
			let m;
			pattern.lastIndex = 0;
			while ((m = pattern.exec(text)) !== null) {
				const nameIdx = m.index + m[1].length;
				const nameRange = new vscode.Range(
					doc.positionAt(nameIdx),
					doc.positionAt(nameIdx + oldName.length),
				);
				edit.replace(fileUri, nameRange, newName);
			}
		} catch {
			// skip
		}
	}

	/** Find the schema.yml co-located with the model and update `- name: oldName`. */
	private async _updateYamlModelName(
		modelPath: string,
		oldName: string,
		newName: string,
		edit: vscode.WorkspaceEdit,
		token: vscode.CancellationToken,
	): Promise<void> {
		const dir = modelPath.replace(/[/\\][^/\\]+$/, '');
		const ymlNames = ['schema.yml', 'models.yml', 'sources.yml'];
		const nameLineRe = new RegExp(`^(\\s*-\\s*name:\\s*)${this._escapeRegex(oldName)}\\s*$`, 'gm');

		for (const ymlName of ymlNames) {
			if (token.isCancellationRequested) return;
			try {
				const ymlUri = vscode.Uri.file(`${dir}/${ymlName}`);
				const doc = await vscode.workspace.openTextDocument(ymlUri);
				const text = doc.getText();
				let m;
				nameLineRe.lastIndex = 0;
				while ((m = nameLineRe.exec(text)) !== null) {
					const nameIdx = m.index + m[1].length;
					const nameRange = new vscode.Range(
						doc.positionAt(nameIdx),
						doc.positionAt(nameIdx + oldName.length),
					);
					edit.replace(ymlUri, nameRange, newName);
				}
			} catch {
				// YAML file doesn't exist at this location — expected
			}
		}
	}

	private _escapeRegex(s: string): string {
		return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	}

	/**
	 * Map a resolved cursor symbol to a rename range + placeholder.
	 * Returns null for positions that are not renameable in-file (e.g. a
	 * relation that isn't a CTE — those are cross-file ref() renames).
	 */
	private _tokenRenameRange(
		sym: Sym,
		partIndex: number | undefined,
		model: DocumentModel,
	): { range: vscode.Range; placeholder: string } | null {
		if (sym.kind === 'column') {
			const isQualifierPart = sym.partSpans !== undefined
				&& partIndex !== undefined
				&& partIndex < sym.partSpans.length - 1;
			if (isQualifierPart) {
				const qRange = qualifierRangeOf(sym);
				if (!qRange) return null;
				const resolved = model.symbolBindings?.sourceOf.get(sym);
				const placeholder = (resolved && model.symbolBindings?.aliasOf.get(resolved)?.name)
					?? sym.name.split('.').slice(0, -1).join('.');
				return { range: qRange, placeholder };
			}
			return { range: nameRangeOf(sym), placeholder: sym.name.split('.').pop()! };
		}

		if (sym.kind === 'alias') {
			return { range: rangeOfSpan(sym.span), placeholder: sym.name };
		}

		if (isRelationSym(sym)) {
			// Only allow in-file rename for CTEs (not for ref() model names — those go through the manifest path)
			const isCte = model.ctes.some(c => c.name === sym.name);
			if (!isCte) return null;
			return { range: relationNameRangeOf(sym), placeholder: sym.name };
		}

		return null;
	}

}
