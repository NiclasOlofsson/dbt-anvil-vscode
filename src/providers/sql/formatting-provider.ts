import * as vscode from 'vscode';
import type { ParseService } from '../../services/parse-service';
import { loadConfig } from '../../ninja/config-loader';
import { FixAction, type NinjaViolation } from '../../ninja/violation';
import type { NinjaConfig } from '../../ninja/config';
import { reflowDocument } from '../../ninja/reflow/engine';

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

		if (!config.autoFix.applyOnFormat) return [];

		const [model, symbols] = await Promise.all([
			this.parseService.getDocumentModel(document),
			this.parseService.getDialectSymbols(),
		]);

		// Format Document is owned end-to-end by the reflow engine. Surgical
		// fixes (cap-keywords, is-null, not-equal, etc.) are NOT applied here —
		// their home is the code-action surface, so the user invokes them
		// explicitly. Mixing the two paths produced the multi-pass
		// convergence pathology that the original reflow engine failed on.
		const reflow = reflowDocument(document, model ?? undefined, config, symbols ?? undefined);
		return reflow.edit ? [reflow.edit] : [];
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
