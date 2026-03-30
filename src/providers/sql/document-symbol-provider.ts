import * as vscode from 'vscode';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import type { ParseService } from '../../services/parse-service';
import type { ILogger } from '../../types/logger';
import { SqlSymbolKind } from '../common/icons';

/**
 * Document symbols for the Outline panel in SQL files.
 * CTEs and final SELECT shown as named symbols with column children,
 * backed by the bridge-parsed DocumentModel.
 */
export class SqlDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) { }

	provideDocumentSymbols(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): vscode.ProviderResult<vscode.DocumentSymbol[]> {
		if (!vscode.workspace.getConfiguration('dbt-studio').get('providers.documentSymbols', true)) return [];
		return this._sqlSymbols(document);
	}

	private async _sqlSymbols(document: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService.getDocumentModel(document, dialect);
		if (!model) return [];
		return this._symbolsFromModel(document, model);
	}

	private _symbolsFromModel(
		document: vscode.TextDocument,
		model: import('../../services/parse-service').DocumentModel,
	): vscode.DocumentSymbol[] {
		if (model.ctes.length === 0 && model.finalColumns.length === 0) return [];

		const symbols: vscode.DocumentSymbol[] = [];
		const lineCount = document.lineCount;

		for (const cte of model.ctes) {
			const startLine = Math.min(cte.line, lineCount - 1);
			const endLine = Math.min(cte.endLine, lineCount - 1);
			const startPos = new vscode.Position(startLine, 0);
			const endPos = document.lineAt(endLine).range.end;
			const range = new vscode.Range(startPos, endPos);
			const selectionRange = document.lineAt(startLine).range;

			const sym = new vscode.DocumentSymbol(
				cte.name,
				'CTE',
				SqlSymbolKind.cte,
				range,
				selectionRange,
			);

			// Add columns as children, navigating to the actual column line
			for (const col of cte.columns) {
				const colLine = Math.min(col.line, lineCount - 1);
				const colRange = document.lineAt(colLine).range;
				const childSym = new vscode.DocumentSymbol(
					col.name,
					'column',
					vscode.SymbolKind.Field,
					colRange,
					colRange,
				);
				sym.children.push(childSym);
			}

			symbols.push(sym);
		}

		// Final SELECT symbol — find the final SELECT start line
		const modelName = this._getModelName(document);
		if (modelName && model.finalColumns.length > 0) {
			const lastLine = lineCount - 1;
			// Try to find the final SELECT: the last SELECT that isn't inside a CTE.
			// Simple heuristic: scan backwards from end for a line starting with "select".
			let finalSelectLine = lastLine;
			for (let i = lastLine; i >= 0; i--) {
				if (/^\s*select\b/i.test(document.lineAt(i).text)) {
					finalSelectLine = i;
					break;
				}
			}
			const startPos = new vscode.Position(finalSelectLine, 0);
			const endPos = document.lineAt(lastLine).range.end;
			const range = new vscode.Range(startPos, endPos);
			const selectionRange = document.lineAt(finalSelectLine).range;
			const finalSym = new vscode.DocumentSymbol(
				modelName,
				'final query',
				vscode.SymbolKind.Class,
				range,
				selectionRange,
			);
			for (const col of model.finalColumns) {
				const colLine = Math.min(col.line, lineCount - 1);
				const colRange = document.lineAt(colLine).range;
				const childSym = new vscode.DocumentSymbol(
					col.name,
					'output column',
					vscode.SymbolKind.Field,
					colRange,
					colRange,
				);
				finalSym.children.push(childSym);
			}
			symbols.push(finalSym);
		}

		this.logger.trace(
			'[parse-service] DocumentSymbol: '
			+ symbols.length + ' symbols from DocumentModel in ' + document.fileName,
		);
		return symbols;
	}

	private _getModelName(document: vscode.TextDocument): string | undefined {
		const fileName = document.fileName.split(/[\\/]/).pop();
		if (!fileName) return undefined;
		return fileName.replace(/\.sql$/, '');
	}
}
