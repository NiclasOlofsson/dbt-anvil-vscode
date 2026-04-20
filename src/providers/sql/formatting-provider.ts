import * as vscode from 'vscode';
import type { ParseService, DocumentModel } from '../../services/parse-service';
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
	) {}

	async provideDocumentFormattingEdits(
		document: vscode.TextDocument,
		_options: vscode.FormattingOptions,
		_token: vscode.CancellationToken,
	): Promise<vscode.TextEdit[]> {
		const config = loadConfig();
		if (!config.enabled) return [];

		const mode = config.format.mode;
		if (mode === 'off') return [];

		const [model, dialectSymbols] = await Promise.all([
			this.parseService.getDocumentModel(document),
			this.parseService.getDialectSymbols(),
		]);

		// Run all rules, apply safe autofixes via the edit planner.
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
