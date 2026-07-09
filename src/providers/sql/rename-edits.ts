import * as vscode from 'vscode';
import type { DocumentModel } from '../../services/parse-service';
import type { Sym } from '../../ftl/sqllens/api';
import { type FixOp, replaceOp } from '../../ninja/fix-op';
import { isRelationSym, nameRangeOf, qualifierRangeOf, rangeOfSpan, relationForAlias, relationNameRangeOf, symsMatchSameCte } from './sym-spans';

/**
 * Rename every occurrence of the alias `sym` names (or that `sym`'s qualifier
 * resolves to, for a column's qualifier part) — the relation's own alias
 * declaration, and every column's qualifier part bound to that SAME relation
 * (object identity, not name — two different relations can share an alias
 * text across nested scopes, e.g. a subquery shadowing an outer one with the
 * same alias; matching by identity is what keeps a rename from touching the
 * wrong one). Shared by the `alias`-kind dispatch and the column-qualifier-
 * part dispatch in `buildInFileRenameOps` below, since both ultimately
 * rename "this alias, everywhere it's written."
 */
function renameAlias(sym: Sym, model: DocumentModel, newName: string): FixOp[] {
	const ops: FixOp[] = [];
	const relation = sym.kind === 'alias'
		? relationForAlias(sym, model.symbols ?? [])
		: sym.source;
	if (!relation?.alias) return ops;

	ops.push(replaceOp(rangeOfSpan(relation.alias.span), newName));
	for (const s of model.symbols ?? []) {
		if (s.kind !== 'column' || !s.modifiers.includes('reference')) continue;
		if (s.source !== relation) continue;
		const qRange = qualifierRangeOf(s);
		if (qRange) ops.push(replaceOp(qRange, newName));
	}
	return ops;
}

/**
 * Build the list of edits that rename an in-file identifier — column,
 * alias, or CTE name — to `newName`, walking the symbol stream and
 * rewriting every affected symbol consistently.
 *
 * Column rename is **scope-aware** when the source column has a resolved
 * binding (`Sym.source`): only other column symbols whose
 * binding points at the SAME relation symbol are rewritten. Same-named
 * columns from different tables are left untouched. This addresses the
 * conflation bug that the legacy `_applyTokenRename` had.
 *
 * Falls back to name-only matching when:
 *   - Source is a declaration site (`AS alias` in a SELECT list — no binding).
 *   - The source column itself has no resolved binding — we can't tell
 *     where it binds, so we treat all same-named refs as potentially the
 *     same (best effort, matches the legacy behaviour for that case).
 *
 * Positions that aren't renameable in-file (a non-CTE relation — those are
 * cross-file `ref()` renames handled separately by the rename provider)
 * yield an empty array.
 *
 * Returns `FixOp[]` so the same edits can flow either through a rule's
 * `FixAction` (code-action surface) or through a VS Code `WorkspaceEdit`
 * (rename provider surface) via the `buildInFileRenameEdits` adapter.
 */
export function buildInFileRenameOps(
	sym: Sym,
	partIndex: number | undefined,
	model: DocumentModel,
	newName: string,
): FixOp[] {
	if (sym.kind === 'alias') {
		return renameAlias(sym, model, newName);
	}

	if (isRelationSym(sym)) {
		// Matched by structural anchor, not name — see symsMatchSameCte's doc comment.
		const ops: FixOp[] = [];
		for (const s of model.symbols ?? []) {
			if (symsMatchSameCte(sym, s)) {
				ops.push(replaceOp(relationNameRangeOf(s), newName));
			}
		}
		return ops;
	}

	if (sym.kind !== 'column') return [];

	const isQualifierPart = sym.partSpans !== undefined
		&& partIndex !== undefined
		&& partIndex < sym.partSpans.length - 1;
	if (isQualifierPart) {
		return renameAlias(sym, model, newName);
	}

	const ops: FixOp[] = [];
	const bareName = sym.name.split('.').pop()!;
	const isDeclaration = sym.modifiers.includes('declaration');
	const sourceResolved = isDeclaration ? undefined : sym.source;
	for (const s of model.symbols ?? []) {
		if (s.kind !== 'column') continue;
		if (s.modifiers.includes('reference') && s.name.split('.').pop() === bareName) {
			// Skip a `SELECT *`'s expanded per-column Syms (sqllens commit 9c87f55,
			// modifiers:['reference','star']) — they have no real source text to
			// rename; renaming through one would insert `newName` next to the `*`
			// instead of touching anything, corrupting the file. Zero-width span is
			// a defensive second check (sqllens guarantees it for these Syms too),
			// not the primary signal — the modifier is the intended one.
			if (s.modifiers.includes('star')) continue;
			if (s.span.column === s.span.endColumn && s.span.line === s.span.endLine) continue;
			if (sourceResolved !== undefined && s.source !== undefined && s.source !== sourceResolved) continue;
			ops.push(replaceOp(nameRangeOf(s), newName));
		} else if (s.modifiers.includes('declaration') && s.name === bareName) {
			ops.push(replaceOp(nameRangeOf(s), newName));
		}
	}
	return ops;
}

/**
 * VS Code adapter: same rename, packaged as a `WorkspaceEdit` for the
 * rename provider entry point. Use `buildInFileRenameOps` when emitting
 * a rule's `FixAction`.
 */
export function buildInFileRenameEdits(
	sym: Sym,
	partIndex: number | undefined,
	model: DocumentModel,
	uri: vscode.Uri,
	newName: string,
): vscode.WorkspaceEdit {
	const edit = new vscode.WorkspaceEdit();
	for (const op of buildInFileRenameOps(sym, partIndex, model, newName)) {
		if (op.kind === 'replace') edit.replace(uri, op.range, op.text);
	}
	return edit;
}
