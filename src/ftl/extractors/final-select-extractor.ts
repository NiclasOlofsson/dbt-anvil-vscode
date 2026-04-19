import type { AstPayload } from '../parse-result';
import type { ColumnInfo, FinalSelectColumnInfo, FinalSelectInfo } from '../../services/parse-service';
import {
	type AstNode,
	childOf,
	expressionsOf,
	findDescendants,
	identifierName,
	identifierPosition,
	unwrapToSelect,
} from '../ast-utils';
import { extractColumnExprName, getColumnExprMetadata } from './column-expr-helpers';

/** Locate the final SELECT node for a query — handles With/Union/Select roots. */
function finalSelectNode(ast: AstPayload[]): AstNode | undefined {
	if (ast.length === 0) return undefined;
	if (ast[0].c === 'Select') return { node: ast[0], index: 0 };
	// Bare UNION / UNION ALL at root (no CTEs) — unwrap to leftmost Select branch.
	if (ast[0].c === 'Union') return unwrapToSelect(ast, { node: ast[0], index: 0 });
	if (ast[0].c === 'With') {
		// WITH ... SELECT ... UNION ALL ... — the 'this' child may be a Union; unwrap it.
		return unwrapToSelect(ast, childOf(ast, 0, 'this'));
	}
	return undefined;
}

/** Bounding box of an expression in 0-based line/col. Iterates all Identifier descendants. */
function expressionBounds(ast: AstPayload[], exprIdx: number): { line: number; col: number; endLine: number; endCol: number } | undefined {
	let minLine = Infinity, minCol = Infinity;
	let maxLine = -Infinity, maxCol = -Infinity;

	const update = (node: AstPayload, name: string) => {
		if (node.m?.line === undefined || node.m.col === undefined) return;
		const line = node.m.line - 1;
		const endCol = node.m.col;   // 0-based exclusive end (sqlglot _col = chars consumed)
		const col = endCol - name.length;
		if (line < minLine || (line === minLine && col < minCol)) { minLine = line; minCol = col; }
		if (line > maxLine || (line === maxLine && endCol > maxCol)) { maxLine = line; maxCol = endCol; }
	};

	const exprNode = ast[exprIdx];
	if (exprNode?.c === 'Identifier') {
		const n = identifierName(ast, exprIdx);
		if (n) update(exprNode, n);
	}

	for (const { node, index } of findDescendants(ast, exprIdx, 'Identifier')) {
		const n = identifierName(ast, index);
		if (n) update(node, n);
	}

	if (maxLine === -Infinity) return undefined;
	return {
		line: minLine === Infinity ? 0 : minLine,
		col: minCol === Infinity ? 0 : minCol,
		endLine: maxLine,
		endCol: maxCol,
	};
}

function buildSelectColumn(ast: AstPayload[], exprIdx: number): FinalSelectColumnInfo | undefined {
	const name = extractColumnExprName(ast, exprIdx);
	if (!name) return undefined;

	const entry: FinalSelectColumnInfo = { name, line: 0, col: 0, endLine: 0, endCol: 0 };

	const bounds = expressionBounds(ast, exprIdx);
	if (bounds) {
		entry.line = bounds.line;
		entry.col = bounds.col;
		entry.endLine = bounds.endLine;
		entry.endCol = bounds.endCol;
	}

	const exprNode = ast[exprIdx];
	if (exprNode.c === 'Alias') {
		const aliasIdent = childOf(ast, exprIdx, 'alias');
		if (aliasIdent?.node.c === 'Identifier') {
			const aName = identifierName(ast, aliasIdent.index);
			if (aName) {
				const pos = identifierPosition(aliasIdent.node, aName);
				if (pos) { entry.aliasLine = pos.line; entry.aliasCol = pos.col; entry.aliasEndCol = pos.endCol; }
			}
		}
		const inner = childOf(ast, exprIdx, 'this');
		if (inner?.node.c === 'Column') {
			const colId = childOf(ast, inner.index, 'this');
			if (colId?.node.c === 'Identifier') entry.expression = identifierName(ast, colId.index);
			const tableId = childOf(ast, inner.index, 'table');
			if (tableId?.node.c === 'Identifier') entry.table = identifierName(ast, tableId.index);
		} else if (inner?.node.c === 'Identifier') {
			entry.expression = identifierName(ast, inner.index);
		}
	} else if (exprNode.c === 'Column') {
		const colId = childOf(ast, exprIdx, 'this');
		if (colId?.node.c === 'Identifier') entry.expression = identifierName(ast, colId.index);
		const tableId = childOf(ast, exprIdx, 'table');
		if (tableId?.node.c === 'Identifier') entry.table = identifierName(ast, tableId.index);
	} else if (exprNode.c === 'Identifier') {
		entry.expression = identifierName(ast, exprIdx);
	}

	return entry;
}

export function extractFinalColumns(ast: AstPayload[]): ColumnInfo[] {
	const sel = finalSelectNode(ast);
	if (!sel) return [];
	const result: ColumnInfo[] = [];
	for (const { index: exprIdx } of expressionsOf(ast, sel.index)) {
		const meta = getColumnExprMetadata(ast, exprIdx);
		if (!meta.name) continue;
		const entry: ColumnInfo = { name: meta.name, line: meta.line };
		if (meta.col !== undefined) entry.col = meta.col;
		result.push(entry);
	}
	return result;
}

/**
 * Returns a Set of 0-based line numbers that are fully or partially inside a
 * SQL comment region (-- line comments or /* block comments *​/).
 * Used to filter AST nodes whose reported position falls inside a comment —
 * which can happen when the jinja blanker replaces {{ }} tags inside SQL
 * comments, causing sqlglot to mis-attribute node positions.
 */
function buildCommentedLines(sql: string): Set<number> {
	const result = new Set<number>();
	let line = 0;
	let i = 0;
	const n = sql.length;

	while (i < n) {
		const ch = sql[i];

		if (ch === '\n') { line++; i++; continue; }

		// -- line comment: rest of line is commented
		if (ch === '-' && sql[i + 1] === '-') {
			result.add(line);
			while (i < n && sql[i] !== '\n') i++;
			continue;
		}

		// /* block comment */
		if (ch === '/' && sql[i + 1] === '*') {
			const startLine = line;
			i += 2;
			while (i < n) {
				if (sql[i] === '\n') { result.add(line); line++; i++; }
				else if (sql[i] === '*' && sql[i + 1] === '/') { i += 2; break; }
				else i++;
			}
			for (let l = startLine; l <= line; l++) result.add(l);
			continue;
		}

		// Single-quoted string — skip contents so -- inside a string is not a comment
		if (ch === '\'') {
			i++;
			while (i < n) {
				if (sql[i] === '\n') { line++; i++; }
				else if (sql[i] === '\'' && sql[i + 1] === '\'') { i += 2; } // escaped quote
				else if (sql[i] === '\'') { i++; break; }
				else i++;
			}
			continue;
		}

		i++;
	}

	return result;
}

export function extractFinalSelect(ast: AstPayload[], sql: string): FinalSelectInfo | undefined {
	const sel = finalSelectNode(ast);
	if (!sel) return undefined;

	const sqlLines = sql.split('\n');
	const commentedLines = buildCommentedLines(sql);
	const columns: FinalSelectColumnInfo[] = [];
	for (const { index: exprIdx } of expressionsOf(ast, sel.index)) {
		const col = buildSelectColumn(ast, exprIdx);
		if (!col) continue;
		if (commentedLines.has(col.line)) continue;
		columns.push(col);
	}

	// Scan backward from the first column line to find the SELECT keyword.
	const colLines = columns.map(c => c.line);
	let selLine = 0, selCol = 0;
	if (colLines.length > 0) {
		const firstColLine = Math.min(...colLines);
		for (let back = firstColLine; back >= Math.max(0, firstColLine - 10); back--) {
			const stripped = (sqlLines[back] ?? '').trimStart();
			if (stripped.toLowerCase().startsWith('select')) {
				selLine = back;
				selCol = (sqlLines[back]?.length ?? 0) - stripped.length;
				break;
			}
		}
	}

	let endLine = selLine, endCol = selCol;
	for (const c of columns) {
		if (c.endLine > endLine || (c.endLine === endLine && c.endCol > endCol)) {
			endLine = c.endLine; endCol = c.endCol;
		}
	}

	return { line: selLine, col: selCol, endLine, endCol, columns };
}
