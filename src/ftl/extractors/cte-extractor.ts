import type { AstPayload } from '../parse-result';
import type { ColumnInfo, CteInfo } from '../../services/parse-service';
import { childOf, expressionsOf, findAll, identifierName, identifierPosition, unwrapToSelect } from '../ast-utils';
import { buildLineStarts, lineAtOffset } from '../jinja-spans';
import { getColumnExprMetadata } from './column-expr-helpers';
import { findMatchingParen } from './sql-paren-utils';

export function extractCtes(
	ast: AstPayload[],
	sql: string,
	wildcardCtes?: Array<{ name: string; line: number; col?: number }>,
): CteInfo[] {
	const lineStarts = buildLineStarts(sql);
	const result: CteInfo[] = [];
	const seen = new Set<string>();

	for (const { index: cteIdx } of findAll(ast, 'CTE')) {
		const tableAlias = childOf(ast, cteIdx, 'alias');
		if (!tableAlias) continue;
		const identNode = childOf(ast, tableAlias.index, 'this');
		if (!identNode) continue;
		const name = identifierName(ast, identNode.index);
		if (!name || seen.has(name)) continue;
		seen.add(name);

		const namePos = identifierPosition(identNode.node, name);
		const startLine0 = namePos?.line ?? Math.max(0, (identNode.node.m?.line ?? 1) - 1);

		// Find opening paren at or after the CTE name's line, then its matching close.
		const searchFrom = lineStarts[Math.min(startLine0, lineStarts.length - 1)] ?? 0;
		const openIdx = sql.indexOf('(', searchFrom);
		let endLine = startLine0;
		let endCol: number | undefined;
		if (openIdx >= 0) {
			const closeEnd = findMatchingParen(sql, openIdx);
			if (closeEnd > 0) {
				const closeOffset = closeEnd - 1; // position of the ')' itself
				endLine = lineAtOffset(closeOffset, lineStarts);
				endCol = (closeOffset - lineStarts[endLine]) + 1; // exclusive end
			}
		}

		// Columns from the body Select's expressions. UNION ALL bodies wrap a Union; unwrap to leftmost Select.
		const bodySelect = unwrapToSelect(ast, childOf(ast, cteIdx, 'this'));
		const wildcardEntry = wildcardCtes?.find(w => w.name === name);
		const columns: ColumnInfo[] = [];
		if (wildcardEntry) {
			// qualify() expanded SELECT * — restore the wildcard using the pre-qualify line.
			const starEntry: ColumnInfo = { name: '*', line: wildcardEntry.line };
			if (wildcardEntry.col !== undefined) starEntry.col = wildcardEntry.col;
			columns.push(starEntry);
		} else if (bodySelect) {
			for (const { index: exprIdx } of expressionsOf(ast, bodySelect.index)) {
				const meta = getColumnExprMetadata(ast, exprIdx);
				if (!meta.name) continue;
				const colEntry: ColumnInfo = { name: meta.name, line: meta.line };
				if (meta.col !== undefined) colEntry.col = meta.col;
				columns.push(colEntry);
			}
		}

		const entry: CteInfo = { name, line: startLine0, endLine, columns };
		if (namePos) entry.col = namePos.col;
		if (endCol !== undefined) entry.endCol = endCol;
		result.push(entry);
	}

	return result;
}

export function extractSubqueries(ast: AstPayload[]): CteInfo[] {
	const result: CteInfo[] = [];

	for (const { index: sqIdx, node: sqNode } of findAll(ast, 'Subquery')) {
		const tableAlias = childOf(ast, sqIdx, 'alias');
		if (!tableAlias || tableAlias.node.c !== 'TableAlias') continue;
		const aliasIdent = childOf(ast, tableAlias.index, 'this');
		if (!aliasIdent || aliasIdent.node.c !== 'Identifier') continue;
		const name = identifierName(ast, aliasIdent.index);
		if (!name) continue;

		const aliasPos = identifierPosition(aliasIdent.node, name);
		const startLine0 = sqNode.m?.line !== undefined ? sqNode.m.line - 1 : (aliasPos?.line ?? 0);
		const endLine = aliasPos?.line ?? startLine0;

		const bodySelect = unwrapToSelect(ast, childOf(ast, sqIdx, 'this'));
		const columns: ColumnInfo[] = [];
		if (bodySelect) {
			for (const { index: exprIdx } of expressionsOf(ast, bodySelect.index)) {
				const meta = getColumnExprMetadata(ast, exprIdx);
				if (!meta.name) continue;
				const colEntry: ColumnInfo = { name: meta.name, line: meta.line };
				if (meta.col !== undefined) colEntry.col = meta.col;
				columns.push(colEntry);
			}
		}

		const entry: CteInfo = { name, line: startLine0, endLine, columns, isSubquery: true };
		if (aliasPos) { entry.col = aliasPos.col; entry.endCol = aliasPos.endCol; }
		result.push(entry);
	}

	return result;
}
