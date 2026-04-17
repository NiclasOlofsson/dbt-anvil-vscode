import * as vscode from 'vscode';
import type { ParseService, DocumentModel } from '../../services/parse-service';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import { runNinja } from '../../ninja/engine';
import { loadConfig } from '../../ninja/config-loader';
import { tokenize } from '../../dbt/jinja-tokenizer';
import { FixAction } from '../../ninja/violation';

/**
 * Document formatting provider powered by Ninja.
 * Collects all auto-fixable violations and applies their edits.
 * SnippetAction and FixAction with autoFix=false are excluded.
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
		// applyOnFormat gates the document-format path \u2014 applies all autoFix edits automatically
		// without any explicit user selection. Individual quick-fixes are always offered regardless.
		if (!config.enabled || !config.autoFix.applyOnFormat) return [];

		const [model, dialectSymbols] = await Promise.all([
			this.parseService.getDocumentModel(document),
			this.parseService.getDialectSymbols(),
		]);
		const jinjaTokens = tokenize(document.getText());
		const emptyModel: DocumentModel = { ctes: [], refs: [], sources: [], tokens: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		const result = runNinja(document, model ?? emptyModel, jinjaTokens, config, dialectSymbols ?? undefined);

		const edits: vscode.TextEdit[] = [];
		for (const v of result.violations) {
			if (v.action?.type !== FixAction.TYPE) continue;
			// Per-rule override takes precedence; fall back to the rule's built-in autoFix flag.
			const autoFix = v.rule in config.autoFix.rules ? config.autoFix.rules[v.rule] : v.action.autoFix;
			if (autoFix) edits.push(...v.action.edits);
		}
		return edits;
	}
}
