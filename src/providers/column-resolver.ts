import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import { ParseService } from '../services/parse-service';
import type { TokenInfo } from '../services/parse-service';

/**
 * Shared column resolution service.  Resolves alias → column-name mappings
 * for SQL files by delegating to ParseService.
 */
export class ColumnResolver {
	constructor(
		private readonly indexer: ManifestIndexer,
		private readonly logger: ILogger,
		private readonly parseService: ParseService,
	) {}

	getCachedAliases(document: vscode.TextDocument): Record<string, string[]> | null {
		return this.parseService.getCachedAliases(document);
	}

	async getScopeAliases(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<Record<string, string[]>> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService.getDocumentModel(document, dialect);
		return model ? ParseService.resolveAliases(model) : {};
	}

	async getTokensAndAliases(
		document: vscode.TextDocument,
		_token: vscode.CancellationToken,
	): Promise<{ tokens: TokenInfo[]; aliases: Record<string, string[]> }> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		const model = await this.parseService.getDocumentModel(document, dialect);
		return { tokens: model?.tokens ?? [], aliases: model ? ParseService.resolveAliases(model) : {} };
	}
}
