import * as vscode from 'vscode';
import type { DocumentModel, PositionResolution, ColumnRefToken, TableRefToken } from '../../services/parse-service';
import { type FixOp, replaceOp } from '../../ninja/fix-op';

/**
 * Build the list of edits that rename an in-file identifier — column,
 * alias, or CTE name — to `newName`, walking the token stream and
 * rewriting every affected token consistently.
 *
 * Column rename is **scope-aware** when the source column has a
 * `resolvedTableRef`: only other `column_ref` tokens whose
 * `resolvedTableRef` points at the SAME table_ref instance are rewritten.
 * Same-named columns from different tables are left untouched. This
 * addresses the conflation bug that the legacy `_applyTokenRename` had.
 *
 * Falls back to name-only matching when:
 *   - Source kind is `column_def` (def-site has no `resolvedTableRef`).
 *   - The source column itself has no `resolvedTableRef` — we can't tell
 *     where it binds, so we treat all same-named refs as potentially the
 *     same (best effort, matches the legacy behaviour for that case).
 *
 * Positions that aren't renameable in-file (a non-CTE `table_ref` —
 * those are cross-file `ref()` renames handled separately by the rename
 * provider) yield an empty array.
 *
 * Returns `FixOp[]` so the same edits can flow either through a rule's
 * `FixAction` (code-action surface) or through a VS Code `WorkspaceEdit`
 * (rename provider surface) via the `buildInFileRenameEdits` adapter.
 */
export function buildInFileRenameOps(
	resolved: PositionResolution,
	model: DocumentModel,
	newName: string,
): FixOp[] {
	const ops: FixOp[] = [];
	const { kind, token } = resolved;

	if (kind === 'column' || kind === 'column_def') {
		const sourceRef = kind === 'column' ? token.resolvedTableRef : undefined;
		for (const t of model.tokens) {
			if (t.type === 'column_ref' && t.name === token.name) {
				if (sourceRef !== undefined && t.resolvedTableRef !== undefined && t.resolvedTableRef !== sourceRef) {
					continue;
				}
				ops.push(replaceOp(new vscode.Range(t.line, t.col, t.line, t.endCol), newName));
			} else if (t.type === 'column_def' && t.name === token.name) {
				ops.push(replaceOp(new vscode.Range(t.line, t.col, t.line, t.endCol), newName));
			}
		}
		return ops;
	}

	if (kind === 'table_alias' || kind === 'table_qualifier') {
		const alias = kind === 'table_alias'
			? token.alias
			: (token as ColumnRefToken).resolvedTableRef?.alias ?? (token as ColumnRefToken).table;
		if (alias !== undefined) {
			for (const t of model.tokens) {
				if (
					t.type === 'table_ref'
					&& t.alias === alias
					&& t.aliasLine !== undefined
					&& t.aliasCol !== undefined
					&& t.aliasEndCol !== undefined
				) {
					ops.push(replaceOp(new vscode.Range(t.aliasLine, t.aliasCol, t.aliasLine, t.aliasEndCol), newName));
				}
				if (
					t.type === 'column_ref'
					&& t.table === alias
					&& t.tableLine !== undefined
					&& t.tableCol !== undefined
					&& t.tableEndCol !== undefined
				) {
					ops.push(replaceOp(new vscode.Range(t.tableLine, t.tableCol, t.tableLine, t.tableEndCol), newName));
				}
			}
		}
		return ops;
	}

	if (kind === 'table_ref') {
		const cteName = (token as TableRefToken).name;
		for (const t of model.tokens) {
			if (t.type === 'table_ref' && t.name === cteName) {
				ops.push(replaceOp(new vscode.Range(t.line, t.col, t.line, t.endCol), newName));
			}
		}
		return ops;
	}

	return ops;
}

/**
 * VS Code adapter: same rename, packaged as a `WorkspaceEdit` for the
 * rename provider entry point. Use `buildInFileRenameOps` when emitting
 * a rule's `FixAction`.
 */
export function buildInFileRenameEdits(
	resolved: PositionResolution,
	model: DocumentModel,
	uri: vscode.Uri,
	newName: string,
): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	for (const op of buildInFileRenameOps(resolved, model, newName)) {
		if (op.kind === 'replace') edit.replace(uri, op.range, op.text);
	}
	return edit;
}
