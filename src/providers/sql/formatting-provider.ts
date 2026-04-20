import * as vscode from 'vscode';
import type { ParseService, DocumentModel } from '../../services/parse-service';
import type { ManifestIndexer } from '../../indexing/manifest-indexer';
import { runNinja } from '../../ninja/engine';
import { loadConfig } from '../../ninja/config-loader';
import { tokenize } from '../../dbt/jinja-tokenizer';
import { FixAction, type NinjaViolation } from '../../ninja/violation';
import { planEdits } from '../../ninja/edit-planner';
import type { NinjaConfig } from '../../ninja/config';

/**
 * Document formatting provider powered by Ninja.
 *
 * Runs all enabled rules, filters violations down to those whose autoFix is
 * permitted by config, then routes them through the edit planner so
 * overlapping fix groups are arbitrated rather than blindly concatenated.
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
		// applyOnFormat gates the document-format path — applies all autoFix edits automatically
		// without any explicit user selection. Individual quick-fixes are always offered regardless.
		if (!config.enabled || !config.autoFix.applyOnFormat) return [];

		const [model, dialectSymbols] = await Promise.all([
			this.parseService.getDocumentModel(document),
			this.parseService.getDialectSymbols(),
		]);
		const jinjaTokens = tokenize(document.getText());
		const emptyModel: DocumentModel = { ctes: [], refs: [], sources: [], tokens: [], finalColumns: [], timing: { parseMs: 0, totalMs: 0 } };
		const result = runNinja(document, model ?? emptyModel, jinjaTokens, config, dialectSymbols ?? undefined);

		const allowed = filterAutoFixViolations(result.violations, config);
		const planned = planEdits(allowed, document);
		return planned.edits;
	}
}

/**
 * Filter violations to those that carry a `FixAction` and whose autoFix
 * policy is enabled in config (per-rule override beats the rule's default).
 *
 * Shared with code-action-provider's "Fix all" / `source.fixAll.ninja` paths
 * so all bulk-apply entry points feed the same planner.
 */
export function filterAutoFixViolations(
	violations: NinjaViolation[],
	config: NinjaConfig,
): NinjaViolation[] {
	const out: NinjaViolation[] = [];
	for (const v of violations) {
		if (v.action?.type !== FixAction.TYPE) continue;
		const autoFix = v.rule in config.autoFix.rules ? config.autoFix.rules[v.rule] : v.action.autoFix;
		if (autoFix) out.push(v);
	}
	return out;
}
