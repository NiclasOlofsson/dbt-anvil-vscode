import * as path from 'node:path';
import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ManifestLoader } from '../dbt/manifest-loader';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import type { DocumentModel } from '../services/parse-service';
import { isLinePositionInComment } from './comment-utils';

/**
 * Go-to-definition for ref('model_name'), source('source', 'table'),
 * CTE names in FROM/JOIN, and column names (alias.column → CTE definition).
 */
export class DbtDefinitionProvider implements vscode.DefinitionProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly loader: ManifestLoader,
		private readonly logger: ILogger,
		private readonly parseService?: ParseService,
	) {}

	async provideDefinition(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Definition | undefined> {
		const line = document.lineAt(position.line).text;

		// Skip comments
		if (isLinePositionInComment(line, position.character)) return undefined;

		// Match ref('model_name') or ref("model_name")
		const refMatch = /ref\(\s*['"]([^'"]+)['"]\s*\)/g;
		let match;
		while ((match = refMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				const def = this._resolveRef(match[1]);
				this.logger.debug(`Definition: ref('${match[1]}') → ${def ? 'resolved' : 'not found'}`);
				return def;
			}
		}

		// Match source('source_name', 'table_name')
		const sourceMatch = /source\(\s*['"]([^'"]+)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
		while ((match = sourceMatch.exec(line)) !== null) {
			const start = match.index;
			const end = start + match[0].length;
			if (position.character >= start && position.character <= end) {
				const def = this._resolveSource(match[1], match[2]);
				this.logger.debug(`Definition: source('${match[1]}', '${match[2]}') → ${def ? 'resolved' : 'not found'}`);
				return def;
			}
		}

		// Token-based resolution: CTE navigation + column definitions
		if (this.parseService) {
			return this._resolveToken(document, position, token);
		}

		return undefined;
	}

	private _resolveRef(modelName: string): vscode.Definition | undefined {
		const models = this.indexer.findModelsByName(modelName);
		if (models.length === 0) return undefined;

		// Multiple packages → return all locations so the editor shows a picker
		if (models.length > 1) {
			return models
				.filter(m => m.path)
				.map(m => new vscode.Location(vscode.Uri.file(m.path), new vscode.Position(0, 0)));
		}

		const model = models[0];
		if (!model.path) return undefined;
		try {
			return new vscode.Location(vscode.Uri.file(model.path), new vscode.Position(0, 0));
		} catch {
			return undefined;
		}
	}

	private _resolveSource(sourceName: string, tableName: string): vscode.Location | undefined {
		const index = this.indexer.index;
		if (!index) return undefined;
		const key = `${sourceName}.${tableName}`;
		const uids = index.nodesByName.get(key);
		if (!uids || uids.length === 0) return undefined;

		const source = index.sources.get(uids[0]);
		if (!source) return undefined;

		// Find the schema.yml that declares this source via its original_file_path
		const raw = this.indexer.getRawNode(uids[0]);
		if (raw && raw.original_file_path) {
			const filePath = path.join(this.loader.projectDir, raw.original_file_path);
			try {
				return new vscode.Location(vscode.Uri.file(filePath), new vscode.Position(0, 0));
			} catch {
				// fall through
			}
		}

		return undefined;
	}

	// ---- Token-based definition (AST position resolution) ----

	private async _resolveToken(
		document: vscode.TextDocument,
		position: vscode.Position,
		token: vscode.CancellationToken,
	): Promise<vscode.Definition | undefined> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService!.getDocumentModel(document, dialect);
		if (token.isCancellationRequested || !model) return undefined;

		const resolved = ParseService.resolveAtPosition(model, position.line, position.character);
		if (!resolved) return undefined;

		switch (resolved.kind) {
			case 'table_ref': {
				const name = resolved.token.name;
				return this._jumpToCte(document, model, name)
					?? this._resolveRef(name);
			}
			case 'table_alias': {
				const name = resolved.token.name;
				return this._jumpToCte(document, model, name)
					?? this._resolveRef(name);
			}
			case 'table_qualifier': {
				const alias = resolved.token.table!;
				return this._jumpToCte(document, model, alias);
			}
			case 'column': {
				const colToken = resolved.token;
				if (colToken.table) {
					return this._jumpToCte(document, model, colToken.table, colToken.name);
				}
				return undefined;
			}
		}
	}

	// ---- Jump to CTE / ref / source by alias name ----

	private _jumpToCte(
		document: vscode.TextDocument,
		model: DocumentModel,
		alias: string,
		column?: string,
	): vscode.Definition | undefined {
		const lc = alias.toLowerCase();

		const cte = model.ctes.find(c => c.name.toLowerCase() === lc || c.alias?.toLowerCase() === lc);
		if (cte) {
			if (column) {
				const col = cte.columns.find(c => c.name.toLowerCase() === column.toLowerCase());
				if (col) {
					this.logger.debug(`Definition: column '${column}' in CTE '${alias}' → line ${col.line + 1}`);
					return new vscode.Location(document.uri, new vscode.Position(col.line, 0));
				}
			}
			this.logger.debug(`Definition: CTE '${alias}' → line ${cte.line + 1}`);
			return new vscode.Location(document.uri, new vscode.Position(cte.line, 0));
		}

		const ref = model.refs.find(r => r.alias?.toLowerCase() === lc);
		if (ref) {
			this.logger.debug(`Definition: alias '${alias}' → ref('${ref.model}')`);
			return this._resolveRef(ref.model) as vscode.Location | undefined;
		}

		const source = model.sources.find(s => s.alias?.toLowerCase() === lc);
		if (source) {
			this.logger.debug(`Definition: alias '${alias}' → source('${source.sourceName}','${source.tableName}')`);
			return this._resolveSource(source.sourceName, source.tableName);
		}

		return undefined;
	}

}

