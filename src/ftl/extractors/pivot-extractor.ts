import type { AstPayload } from '../parse-result';
import { childOf, expressionsOf, findAll, identifierName } from '../ast-utils';

/**
 * Detect PIVOT/UNPIVOT nodes in the AST and return the virtual (output) column
 * names they synthesise per source table.
 *
 * Standard UNPIVOT syntax: `FROM t UNPIVOT (val FOR name IN (col1, col2, ...))`
 * creates two virtual columns — `val` (holds the pivoted value) and `name`
 * (holds the category label). Neither exists in `t`'s schema, but both are
 * valid references in the enclosing SELECT. This mapping lets column validation
 * skip false "column not found" errors for those virtual names.
 *
 * Returns a plain object keyed by the lowercased source-table name.
 */
export function extractPivotVirtualColumns(ast: AstPayload[]): Record<string, string[]> {
	const result: Record<string, string[]> = {};

	for (const { index: pivotIdx } of findAll(ast, 'Pivot')) {
		// Only handle UNPIVOT (unpivot arg = true leaf child)
		const isUnpivot = ast.some(n => n.i === pivotIdx && n.k === 'unpivot' && n.v === true);
		if (!isUnpivot) continue;

		// The Pivot is attached to a Table via the `pivots` arg key
		const pivotNode = ast[pivotIdx];
		const tableIdx = pivotNode.i;
		if (tableIdx === undefined) continue;
		if (ast[tableIdx]?.c !== 'Table') continue;

		// Source table name
		const tableIdNode = childOf(ast, tableIdx, 'this');
		if (!tableIdNode) continue;
		const tableName = identifierName(ast, tableIdNode.index);
		if (!tableName) continue;

		const cols: string[] = result[tableName.toLowerCase()] ?? [];

		// Value column(s) live in Pivot.expressions
		for (const { index: exprIdx, node: exprNode } of expressionsOf(ast, pivotIdx, 'expressions')) {
			const name = pivotColName(ast, exprIdx, exprNode.c);
			if (name) cols.push(name);
		}

		// Name/category column lives in Pivot.fields → In.this
		for (const { index: fieldIdx } of expressionsOf(ast, pivotIdx, 'fields')) {
			const inThisNode = childOf(ast, fieldIdx, 'this');
			if (!inThisNode) continue;
			const name = pivotColName(ast, inThisNode.index, inThisNode.node.c);
			if (name) cols.push(name);
		}

		if (cols.length > 0) result[tableName.toLowerCase()] = cols;
	}

	return result;
}

/** Extract the column name from a Column or Identifier AST node. */
function pivotColName(ast: AstPayload[], idx: number, className?: string): string | undefined {
	if (className === 'Column') {
		const colId = childOf(ast, idx, 'this');
		if (colId?.node.c === 'Identifier') return identifierName(ast, colId.index);
		return undefined;
	}
	if (className === 'Identifier') return identifierName(ast, idx);
	return undefined;
}
