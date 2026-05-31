import { describe, it, expect } from 'vitest';
import * as vscode from 'vscode';
import { buildInFileRenameEdits } from '../../providers/sql/rename-edits';
import { model, colRef, tableRef, colDef } from '../ninja/helpers';
import type { ColumnRefToken, TableRefToken } from '../../services/parse-service';

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
		const ordersRef = tableRef('orders', 1, 5, 'o');
		const usersRef = tableRef('users', 1, 15, 'u');
		const orderCol = colRef('customer_id', 0, 9, 'o', ordersRef);
		const userCol = colRef('customer_id', 0, 25, 'u', usersRef);
		const m = model({ tokens: [ordersRef, usersRef, orderCol, userCol] });

		const edit = buildInFileRenameEdits({ kind: 'column', token: orderCol }, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		expect(edits).toEqual([
			{ line: 0, col: 9, endCol: 20, newText: 'customer_pk' },
		]);
	});

	it('renames every column_ref that binds to the same source table', () => {
		// FROM orders o
		// SELECT o.customer_id, customer_id ...
		// (when both qualified and unqualified refs share the same resolution)
		const ordersRef = tableRef('orders', 1, 5, 'o');
		const qualifiedRef = colRef('customer_id', 0, 9, 'o', ordersRef);
		const unqualifiedRef = colRef('customer_id', 0, 25, undefined, ordersRef);
		const m = model({ tokens: [ordersRef, qualifiedRef, unqualifiedRef] });

		const edit = buildInFileRenameEdits({ kind: 'column', token: qualifiedRef }, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		expect(edits.length).toBe(2);
		expect(edits[0]).toEqual({ line: 0, col: 9, endCol: 20, newText: 'customer_pk' });
		expect(edits[1]).toEqual({ line: 0, col: 25, endCol: 36, newText: 'customer_pk' });
	});

	it('does NOT rename a column with the same name but a different resolved source', () => {
		const ordersRef = tableRef('orders', 1, 5, 'o');
		const usersRef = tableRef('users', 1, 15, 'u');
		const orderCol = colRef('email', 0, 9, 'o', ordersRef);
		const userCol = colRef('email', 0, 25, 'u', usersRef);
		const m = model({ tokens: [ordersRef, usersRef, orderCol, userCol] });

		const edit = buildInFileRenameEdits({ kind: 'column', token: orderCol }, m, URI, 'email_address');

		const edits = flatEdits(edit);
		expect(edits.length).toBe(1);
		expect(edits[0].line).toBe(0);
		expect(edits[0].col).toBe(9);  // orders side only
	});

	it('renames an unqualified column when source has no resolvedTableRef (best-effort name match)', () => {
		// Pure name fallback when the source column itself can't be resolved.
		const col1 = colRef('customer_id', 0, 7, undefined, undefined);
		const col2 = colRef('customer_id', 1, 7, undefined, undefined);
		const m = model({ tokens: [col1, col2] });

		const edit = buildInFileRenameEdits({ kind: 'column', token: col1 }, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		// Both unqualified refs get renamed because we can't distinguish them.
		expect(edits.length).toBe(2);
	});

	it('includes a column_def site in the rename when matching by name', () => {
		const colDefTok = colDef('customer_id', 0, 12);
		const colRefTok = colRef('customer_id', 1, 7);
		const m = model({ tokens: [colDefTok, colRefTok] });

		const edit = buildInFileRenameEdits({ kind: 'column_def', token: colDefTok }, m, URI, 'customer_pk');

		const edits = flatEdits(edit);
		expect(edits.length).toBe(2);
	});

	// ── Table alias rename ─────────────────────────────────────────────

	it('renames a table alias and all qualifier spans on column_refs', () => {
		// FROM orders o
		// SELECT o.customer_id, o.email ...
		const ordersRef = tableRef('orders', 1, 5, 'o');
		const col1 = colRef('customer_id', 0, 9, 'o', ordersRef);
		const col2 = colRef('email', 0, 25, 'o', ordersRef);
		// Manually wire qualifier spans on the column_refs (synthesized for test).
		col1.tableLine = 0; col1.tableCol = 7; col1.tableEndCol = 8;
		col2.tableLine = 0; col2.tableCol = 23; col2.tableEndCol = 24;

		const m = model({ tokens: [ordersRef, col1, col2] });

		const edit = buildInFileRenameEdits({ kind: 'table_alias', token: ordersRef }, m, URI, 'ord');

		const edits = flatEdits(edit);
		// 1 alias def + 2 qualifier spans = 3 edits.
		expect(edits.length).toBe(3);
	});

	// ── CTE rename ─────────────────────────────────────────────────────

	it('renames a CTE name and all table_ref tokens referencing it', () => {
		// WITH my_cte AS (...) SELECT * FROM my_cte JOIN my_cte AS x ON ...
		const cteDef: TableRefToken = {
			type: 'table_ref',
			name: 'my_cte',
			line: 0,
			col: 5,
			endCol: 11,
			cteDefinition: true,
		};
		const cteUse1: TableRefToken = { type: 'table_ref', name: 'my_cte', line: 1, col: 15, endCol: 21 };
		const cteUse2: TableRefToken = { type: 'table_ref', name: 'my_cte', line: 1, col: 27, endCol: 33, alias: 'x' };

		const m = model({ tokens: [cteDef, cteUse1, cteUse2] });

		const edit = buildInFileRenameEdits({ kind: 'table_ref', token: cteDef }, m, URI, 'renamed_cte');

		const edits = flatEdits(edit);
		// 3 table_refs total — all rewritten by name.
		expect(edits.length).toBe(3);
	});

	// ── No-op cases ────────────────────────────────────────────────────

	it('returns empty edit for a position that does not resolve to a renameable in-file kind', () => {
		// A table_qualifier where the column lacks the necessary span info — no-op.
		const orphan: ColumnRefToken = {
			type: 'column_ref',
			name: 'x',
			line: 0,
			col: 0,
			endCol: 1,
		};
		const m = model({ tokens: [orphan] });

		const edit = buildInFileRenameEdits({ kind: 'table_qualifier', token: orphan }, m, URI, 'new');

		expect(flatEdits(edit).length).toBe(0);
	});
});
