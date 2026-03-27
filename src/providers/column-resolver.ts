import * as vscode from 'vscode';
import type { ManifestIndexer } from '../indexing/manifest-indexer';
import type { ILogger } from '../types/logger';
import type { ParseService, TokenInfo } from '../services/parse-service';

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

	invalidateCache(): void {
		this.parseService.invalidateEnrichment();
		this.logger.debug('ColumnResolver: cache invalidated');
	}

	getCachedAliases(document: vscode.TextDocument): Record<string, string[]> | null {
		return this.parseService.getCachedAliases(document);
	}

	async getScopeAliases(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<Record<string, string[]>> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		return this.parseService.getAliases(document, dialect, token);
	}

	async getTokensAndAliases(
		document: vscode.TextDocument,
		token: vscode.CancellationToken,
	): Promise<{ tokens: TokenInfo[]; aliases: Record<string, string[]> }> {
		const dialect = this.indexer.index?.adapterType ?? 'ansi';
		// getDocumentModel is cached — second call in getAliases is free.
		const model = await this.parseService.getDocumentModel(document, dialect);
		const aliases = await this.parseService.getAliases(document, dialect, token);
		return { tokens: model?.tokens ?? [], aliases };
	}
}
