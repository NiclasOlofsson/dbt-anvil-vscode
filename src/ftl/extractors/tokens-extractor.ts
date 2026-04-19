import type { AstPayload } from '../parse-result';
import type {
	ColumnDefToken,
	ColumnRefToken,
	CteInfo,
	TableRefToken,
	TokenInfo,
} from '../../services/parse-service';
import { childOf, findAll, identifierName, identifierPosition, innermostScope } from '../ast-utils';

/**
 * Extract all token references from the AST.
 *
 * Emits three token kinds mirroring the bridge:
 *   - column_ref  : every Column node (with optional table qualifier)
 *   - column_def  : every Alias node (the alias identifier becomes the definition site)
 *   - table_ref   : every Table node in FROM/JOIN, plus one per CTE definition site
 */
export function extractTokens(ast: AstPayload[], ctes: CteInfo[]): TokenInfo[] {
	const tokens: TokenInfo[] = [];

	// 1. CTE definition sites → table_ref (mirrors bridge behaviour)
	for (const cte of ctes) {
		if (cte.col !== undefined) {
			tokens.push({
				type: 'table_ref',
				name: cte.name,
				line: cte.line,
				col: cte.col,
				endCol: cte.col + cte.name.length,
				cteDefinition: true,
			});
		}
	}

	// 2. Column nodes → column_ref
	for (const { index } of findAll(ast, 'Column')) {
		const colId = childOf(ast, index, 'this');
		if (colId?.node.c !== 'Identifier') continue;
		const colName = identifierName(ast, colId.index);
		if (!colName) continue;
		const pos = identifierPosition(colId.node, colName);
		if (!pos) continue;

		const token: ColumnRefToken = { type: 'column_ref', name: colName, ...pos };
		token.scopeId = innermostScope(ast, index);

		const tblId = childOf(ast, index, 'table');
		if (tblId?.node.c === 'Identifier') {
			const tblName = identifierName(ast, tblId.index);
			if (tblName) {
				token.table = tblName;
				const tblPos = identifierPosition(tblId.node, tblName);
				if (tblPos) {
					token.tableLine = tblPos.line;
					token.tableCol = tblPos.col;
					token.tableEndCol = tblPos.endCol;
				}
			}
		}

		tokens.push(token);
	}

	// 3. Alias nodes → column_def
	for (const { index } of findAll(ast, 'Alias')) {
		const aliasId = childOf(ast, index, 'alias');
		if (aliasId?.node.c !== 'Identifier') continue;
		const aliasName = identifierName(ast, aliasId.index);
		if (!aliasName) continue;
		const pos = identifierPosition(aliasId.node, aliasName);
		if (!pos) continue;
		const colDef: ColumnDefToken = { type: 'column_def', name: aliasName, ...pos };
		tokens.push(colDef);
	}

	// 4. Table nodes → table_ref
	for (const { index } of findAll(ast, 'Table')) {
		const tblId = childOf(ast, index, 'this');
		if (tblId?.node.c !== 'Identifier') continue;
		const tblName = identifierName(ast, tblId.index);
		if (!tblName) continue;
		const pos = identifierPosition(tblId.node, tblName);
		if (!pos) continue;

		const token: TableRefToken = { type: 'table_ref', name: tblName, ...pos };
		token.scopeId = innermostScope(ast, index);

		const aliasNode = childOf(ast, index, 'alias');
		if (aliasNode?.node.c === 'TableAlias') {
			const aliasId = childOf(ast, aliasNode.index, 'this');
			if (aliasId?.node.c === 'Identifier') {
				const aName = identifierName(ast, aliasId.index);
				if (aName) {
					token.alias = aName;
					const aPos = identifierPosition(aliasId.node, aName);
					if (aPos) {
						token.aliasLine = aPos.line;
						token.aliasCol = aPos.col;
						token.aliasEndCol = aPos.endCol;
					} else {
						// No source position → alias was synthesised by qualify(), not written by the user.
						token.synthesized = true;
					}
				}
			}
		}

		tokens.push(token);
	}

	// 5. Subquery nodes → table_ref (aliased derived tables)
	for (const { index: sqIdx } of findAll(ast, 'Subquery')) {
		const tableAlias = childOf(ast, sqIdx, 'alias');
		if (!tableAlias || tableAlias.node.c !== 'TableAlias') continue;
		const aliasId = childOf(ast, tableAlias.index, 'this');
		if (aliasId?.node.c !== 'Identifier') continue;
		const aName = identifierName(ast, aliasId.index);
		if (!aName) continue;
		const aPos = identifierPosition(aliasId.node, aName);
		if (!aPos) continue;

		const token: TableRefToken = {
			type: 'table_ref',
			name: aName,
			alias: aName,
			line: aPos.line,
			col: aPos.col,
			endCol: aPos.endCol,
			aliasLine: aPos.line,
			aliasCol: aPos.col,
			aliasEndCol: aPos.endCol,
			isSubquery: true,
		};
		// The alias belongs to the parent scope (the scope that contains the subquery).
		token.scopeId = innermostScope(ast, sqIdx);
		tokens.push(token);
	}

	return tokens;
}

/**
 * For each column_ref token that has a table qualifier, resolve it to the
 * matching table_ref by alias within the same CTE scope. Mirrors the
 * post-processing pass in bridge.py.
 */
export function resolveTableRefs(tokens: TokenInfo[]): void {
	const aliasedRefs = tokens.filter(
		(t): t is TableRefToken => t.type === 'table_ref' && t.alias !== undefined,
	);

	for (const tok of tokens) {
		if (tok.type !== 'column_ref' || !tok.table) continue;

		const qualifierLc = tok.table.toLowerCase();
		const colLine = tok.line;

		// Match table_refs in the same AST scope (same Subquery/CTE ancestor).
		const scopeRefs = aliasedRefs.filter(tr => tr.scopeId === tok.scopeId);

		// Prefer latest alias definition at or before the column.
		let best: TableRefToken | undefined;
		for (const tr of scopeRefs) {
			if ((tr.alias ?? '').toLowerCase() !== qualifierLc) continue;
			if (tr.line > colLine) continue;
			if (!best || tr.line > best.line) best = tr;
		}
		// Fallback: latest alias match in scope (handles forward references
		// and nested subqueries where the outermost alias is at the largest line).
		if (!best) {
			for (const tr of scopeRefs) {
				if ((tr.alias ?? '').toLowerCase() !== qualifierLc) continue;
				if (!best || tr.line > best.line) best = tr;
			}
		}

		if (best) tok.resolvedTableRef = best;
	}
}
