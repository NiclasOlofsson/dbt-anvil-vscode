import * as vscode from 'vscode';
import type { NinjaConfig } from '../config';
import type { DocumentModel } from '../../services/parse-service';
import type { DialectSymbols } from '../../ftl/sql-parser';
import { parseFmtOffRegions, isInFmtOffRegion } from '../jinja/directive-parser';
import { createIndentPolicy } from './indent-policy';
import { printDocument } from './printer';

/**
 * Result of a reflow pass.
 *
 * - `edit` is `null` when the reflow declined to reformat (parse failure,
 *   no model available, disabled by config). Callers should treat that as
 *   "no-op" rather than "empty document".
 * - `reason` is a short human-readable explanation so the formatting
 *   provider can log why it fell back.
 */
export interface ReflowResult {
	edit: vscode.TextEdit | null;
	reason?: string;
}

/**
 * Reformat a document by:
 *   1. Reading the parsed model (AST + merged token timeline).
 *   2. Walking the timeline through {@link printDocument} to produce new text.
 *   3. Preserving `{% ninja fmt: off %}` regions verbatim.
 *
 * The engine is explicitly additive — it does NOT consume rule autofixes.
 * Structural concerns (indent, comma/operator position, line layout) are
 * owned here end-to-end. Rule-driven surgical fixes remain the code-action
 * provider's territory.
 */
export function reflowDocument(
	document: vscode.TextDocument,
	model: DocumentModel | undefined,
	config: NinjaConfig,
	symbols?: DialectSymbols,
): ReflowResult {
	if (!model) return { edit: null, reason: 'no parsed model available' };

	const source = document.getText();
	const stream = model.ninjaSqlTokens ?? [];
	if (stream.length === 0) {
		return { edit: null, reason: 'no tokens to reflow' };
	}
	const ast = model.ast ?? [];

	// Short-circuit when any fmt-off region covers the document — handing back a
	// no-op edit is simpler than threading region-splicing through the printer
	// for documents that are entirely opted-out.
	const lines = source.split('\n');
	const fmtOff = parseFmtOffRegions(lines);
	if (fmtOff.length > 0 && lines.every((_, i) => isInFmtOffRegion(i, fmtOff))) {
		return { edit: null, reason: 'document entirely inside fmt-off region' };
	}

	const policy = createIndentPolicy(config);
	// Prefer a model-supplied index (the sqllens path builds one from its IR);
	// otherwise the printer derives one from the flat `ast` payload.
	const rendered = printDocument({ stream, ast, astIndex: model.astIndex, source, config, policy, symbols });

	if (rendered === source) {
		return { edit: null, reason: 'document already matches policy' };
	}

	// Preserve any fmt-off regions by splicing their original spans back in.
	// When the printer grows smarter this will collapse into a printer-side
	// concern; for now it belongs here so the scaffold is safe to ship.
	const finalText = fmtOff.length > 0
		? spliceFmtOffRegions(rendered, source, lines, fmtOff)
		: rendered;

	const fullRange = new vscode.Range(
		document.positionAt(0),
		document.positionAt(source.length),
	);
	return { edit: vscode.TextEdit.replace(fullRange, finalText) };
}

/**
 * Naive fmt-off preservation: re-overlay the original source for any line
 * that fell inside a fmt-off region. Safe for the current printer because
 * the printer does not reorder lines; a smarter printer will need a
 * token-level strategy here.
 */
function spliceFmtOffRegions(
	rendered: string,
	source: string,
	sourceLines: string[],
	regions: ReturnType<typeof parseFmtOffRegions>,
): string {
	const renderedLines = rendered.split('\n');
	for (let i = 0; i < sourceLines.length && i < renderedLines.length; i++) {
		if (isInFmtOffRegion(i, regions)) {
			renderedLines[i] = sourceLines[i];
		}
	}
	void source;
	return renderedLines.join('\n');
}
