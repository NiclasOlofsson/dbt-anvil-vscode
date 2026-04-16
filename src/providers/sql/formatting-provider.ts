import * as vscode from 'vscode';
import type { ParseService, DocumentModel } from '../../services/parse-service';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import { runNinja } from '../../ninja/engine';
import { loadConfig } from '../../ninja/config-loader';
import { tokenize } from '../../dbt/jinja-tokenizer';

/**
 * Document formatting provider powered by Ninja.
 * Collects all auto-fixable violations and applies their edits.
 * Violations with `noAutoFix: true` (e.g. delete unused CTE) are excluded.
 */
export class NinjaFormattingProvider implements vscode.DocumentFormattingEditProvider {
	constructor(
		private readonly parseService: ParseService,
		private readonly indexer: ManifestIndexer,
	) {}

	async provideDocumentFormattingEdits(
		document: vscode.TextDocument,
		_options: vscode.FormattingOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.TextEdit[]> {
		const config = loadConfig();
		if (!config.enabled) return [];

		const [model, dialectSymbols] = await Promise.all([
			this.parseService.getDocumentModel(document),
			this.parseService.getDialectSymbols(),
		]);
		const jinjaTokens = tokenize(document.getText());
		const emptyModel: DocumentModel = { ctes: [], refs: [], sources: [], tokens: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		const result = runNinja(document, model ?? emptyModel, jinjaTokens, config, dialectSymbols ?? undefined);

		const edits: vscode.TextEdit[] = [];
		for (const v of result.violations) {
			if (v.fix && !v.noAutoFix) edits.push(...v.fix);
		}
		return edits;
	}
}
