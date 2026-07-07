import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { buildInFileRenameEdits } from '../../providers/sql/rename-edits';
import { model, sym, colSym, symbolBindings } from '../ninja/helpers';

const URI = vscode.Uri.file('/test.sql');

function flatEdits(edit: vscode.WorkspaceEdit): Array<{ line: number; col: number; endCol: number; newText: string }> {
	const out: Array<{ line: number; col: number; endCol: number; newText: string }> = [];
	for (const [, edits] of edit.entries()) {
		for (const e of edits) {
			out.push({
				line: e.range.start.line,
				col: e.range.start.character,
				endCol: e.range.end.character,
				newText: e.newText,
			});
		}
	}
	return out.sort((a, b) => a.line - b.line || a.col - b.col);
}

describe('buildInFileRenameEdits', () => {
	// ── Column rename — scope aware ────────────────────────────────────

	it('renames a column scoped to its source table only', () => {
		// FROM orders o, users u
		// SELECT o.customer_id, u.customer_id ...
		const ordersRelation = sym('table', 'orders', 1, 5);
		const usersRelation = sym('table', 'users', 1, 15);
		const orderCol = colSym(0, [{ name: 'o', col: 7 }, { name: 'customer_id', col: 9 }]);
		const userCol = colSym(0, [{ name: 'u', col: 23 }, { name: 'customer_id', col: 25 }]);
		const m = model({
			symbols: [ordersRelation, usersRelation, orderCol, userCol],
			symbolBindings: symbolBindings({ sourceOf: [[orderCol, ordersRelation], [userCol, usersRelation]] }),
		});

		const edit = buildInFileRenameEdits(orderCol, undefined, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		expect(edits).toEqual([
			{ line: 0, col: 9, endCol: 20, newText: 'customer_pk' },
		]);
	});

	it('renames every column ref that binds to the same source table', () => {
		// FROM orders o
		// SELECT o.customer_id, customer_id ...
		// (when both qualified and unqualified refs share the same resolution)
		const ordersRelation = sym('table', 'orders', 1, 5);
		const qualifiedRef = colSym(0, [{ name: 'o', col: 7 }, { name: 'customer_id', col: 9 }]);
		const unqualifiedRef = colSym(0, [{ name: 'customer_id', col: 25 }]);
		const m = model({
			symbols: [ordersRelation, qualifiedRef, unqualifiedRef],
			symbolBindings: symbolBindings({ sourceOf: [[qualifiedRef, ordersRelation], [unqualifiedRef, ordersRelation]] }),
		});

		const edit = buildInFileRenameEdits(qualifiedRef, undefined, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		expect(edits.length).toBe(2);
		expect(edits[0]).toEqual({ line: 0, col: 9, endCol: 20, newText: 'customer_pk' });
		expect(edits[1]).toEqual({ line: 0, col: 25, endCol: 36, newText: 'customer_pk' });
	});

	it('does NOT rename a column with the same name but a different resolved source', () => {
		const ordersRelation = sym('table', 'orders', 1, 5);
		const usersRelation = sym('table', 'users', 1, 15);
		const orderCol = colSym(0, [{ name: 'o', col: 7 }, { name: 'email', col: 9 }]);
		const userCol = colSym(0, [{ name: 'u', col: 23 }, { name: 'email', col: 25 }]);
		const m = model({
			symbols: [ordersRelation, usersRelation, orderCol, userCol],
			symbolBindings: symbolBindings({ sourceOf: [[orderCol, ordersRelation], [userCol, usersRelation]] }),
		});

		const edit = buildInFileRenameEdits(orderCol, undefined, m, URI, 'email_address');

		const edits = flatEdits(edit);
		expect(edits.length).toBe(1);
		expect(edits[0].line).toBe(0);
		expect(edits[0].col).toBe(9);  // orders side only
	});

	it('renames an unqualified column when source has no resolved binding (best-effort name match)', () => {
		// Pure name fallback when the source column itself can't be resolved.
		const col1 = colSym(0, [{ name: 'customer_id', col: 7 }]);
		const col2 = colSym(1, [{ name: 'customer_id', col: 7 }]);
		const m = model({ symbols: [col1, col2], symbolBindings: symbolBindings() });

		const edit = buildInFileRenameEdits(col1, undefined, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		// Both unqualified refs get renamed because we can't distinguish them.
		expect(edits.length).toBe(2);
	});

	it('includes a declaration site in the rename when matching by name', () => {
		// A declaration Sym's own span covers the WHOLE projection ("some_expr as
		// customer_id"), not just the alias — matching what deriveSymbols actually
		// emits. The rename must narrow to just the alias (col 12..23), not replace
		// the whole clause (which would delete "some_expr as ").
		const colDecl = sym('column', 'customer_id', 0, 5, { modifiers: ['declaration', 'output'], endCol: 23 });
		const colRef = colSym(1, [{ name: 'customer_id', col: 7 }]);
		const m = model({ symbols: [colDecl, colRef], symbolBindings: symbolBindings() });

		const edit = buildInFileRenameEdits(colDecl, undefined, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		expect(edits.length).toBe(2);
		expect(edits.find(e => e.line === 0)).toEqual({ line: 0, col: 12, endCol: 23, newText: 'customer_pk' });
	});

	// ── Table alias rename ─────────────────────────────────────────────

	it('renames a table alias and all qualifier spans on column refs', () => {
		// FROM orders o
		// SELECT o.customer_id, o.email ...
		const ordersRelation = sym('table', 'orders', 1, 5);
		const ordersAlias = sym('alias', 'o', 1, 12, { modifiers: ['declaration'] });
		const col1 = colSym(0, [{ name: 'o', col: 7 }, { name: 'customer_id', col: 9 }]);
		const col2 = colSym(0, [{ name: 'o', col: 23 }, { name: 'email', col: 25 }]);
		const m = model({
			symbols: [ordersRelation, ordersAlias, col1, col2],
			symbolBindings: symbolBindings({
				aliasOf: [[ordersRelation, ordersAlias]],
				sourceOf: [[col1, ordersRelation], [col2, ordersRelation]],
			}),
		});

		const edit = buildInFileRenameEdits(ordersAlias, undefined, m, URI, 'ord');

		const edits = flatEdits(edit);
		// 1 alias def + 2 qualifier spans = 3 edits.
		expect(edits.length).toBe(3);
	});

	// ── CTE rename ─────────────────────────────────────────────────────

	it('renames a CTE name and all reference syms for it', () => {
		// WITH my_cte AS (...) SELECT * FROM my_cte JOIN my_cte AS x ON ...
		// The declaration Sym's own span covers the WHOLE "my_cte AS (...)" clause
		// (the name comes first) — the rename must narrow to just the name (col
		// 5..11), not replace the whole clause (which would delete the CTE body).
		const cteDecl = sym('cte', 'my_cte', 0, 5, { modifiers: ['declaration'], endCol: 30 });
		const cteUse1 = sym('cte', 'my_cte', 1, 15, { definitionOf: cteDecl });
		const cteUse2 = sym('cte', 'my_cte', 1, 27, { definitionOf: cteDecl });
		const m = model({ symbols: [cteDecl, cteUse1, cteUse2], symbolBindings: symbolBindings() });

		const edit = buildInFileRenameEdits(cteDecl, undefined, m, URI, 'renamed_cte');

		const edits = flatEdits(edit);
		// 3 cte syms total — all rewritten by name.
		expect(edits.length).toBe(3);
		expect(edits[0]).toEqual({ line: 0, col: 5, endCol: 11, newText: 'renamed_cte' });
	});

	// ── No-op cases ────────────────────────────────────────────────────

	it('returns empty edit when a qualifier part has no resolved source binding', () => {
		// A column qualifier we can't correlate to any relation — no-op.
		const orphan = colSym(0, [{ name: 'x', col: 0 }, { name: 'y', col: 2 }]);
		const m = model({ symbols: [orphan], symbolBindings: symbolBindings() });

		const edit = buildInFileRenameEdits(orphan, 0, m, URI, 'new');

		expect(flatEdits(edit).length).toBe(0);
	});
});
