import * as vscode from 'vscode';
import { Rewriter } from './rewriter';
import type { FixGroup } from '../edit-planner';
import type { FixOp } from '../fix-op';
import type { NinjaConfig } from '../config';

/**
 * Apply a set of arbitrated, non-overlapping fix groups to a document using
 * the Rewriter's forward-walk delta tracking.
 *
 * Groups must be sorted ascending by start offset (planEdits guarantees this).
 * Returns a single full-document TextEdit.replace, or an empty array when no
 * changes were made.
 */
export function applyFixGroups(
	groups: FixGroup[],
	document: vscode.TextDocument,
	config: NinjaConfig,
): vscode.TextEdit[] {
	if (groups.length === 0) return [];

	const source = document.getText();
	const rewriter = new Rewriter(source);

	for (const group of groups) {
		// Sort ops within each group ascending so paired ops (insert+delete) apply
		// in document order without invalidating each other's positions.
		const sorted = [...group.ops].sort((a, b) => opOffset(a, document) - opOffset(b, document));
		for (const op of sorted) {
			applyOp(op, document, rewriter, config);
		}
	}

	const result = rewriter.render();
	if (result === source) return [];

	const fullRange = new vscode.Range(
		new vscode.Position(0, 0),
		document.positionAt(source.length),
	);
	return [vscode.TextEdit.replace(fullRange, result)];
}

function opOffset(op: FixOp, document: vscode.TextDocument): number {
	return op.kind === 'insert' || op.kind === 'linebreak'
		? document.offsetAt(op.position)
		: document.offsetAt(op.range.start);
}

function applyOp(op: FixOp, document: vscode.TextDocument, rewriter: Rewriter, config: NinjaConfig): void {
	switch (op.kind) {
		case 'replace':
			rewriter.apply(document.offsetAt(op.range.start), document.offsetAt(op.range.end), op.text);
			break;
		case 'insert':
			rewriter.apply(document.offsetAt(op.position), document.offsetAt(op.position), op.text);
			break;
		case 'delete':
			rewriter.apply(document.offsetAt(op.range.start), document.offsetAt(op.range.end), '');
			break;
		case 'linebreak': {
			const unit = config.indentation.unit === 'tab' ? '\t' : ' '.repeat(config.indentation.size);
			rewriter.apply(document.offsetAt(op.position), document.offsetAt(op.position), '\n' + unit.repeat(op.indent));
			break;
		}
	}
}
