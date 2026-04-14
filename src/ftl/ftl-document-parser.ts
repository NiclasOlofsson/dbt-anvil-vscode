import type { AstPayload, JinjaTagSpan, ParseWarning } from './parse-result';
import type { ColumnDefToken, ColumnInfo, ColumnRefToken, CteInfo, DocumentModel, FinalSelectColumnInfo, FinalSelectInfo, RefInfo, SourceInfo, SqlglotWarning, TableRefToken, TokenInfo } from '../services/parse-service';
import type { DocumentParser, ParseOptions } from '../services/document-parser';
import type { SqlParser } from './sql-parser';
import { PyodideWorkerPool, type PoolOptions } from './pyodide-worker-pool';
import { buildLineStarts, lineAtOffset } from './jinja-spans';
import { findMatchingParen } from '../tools/cte-extractor';
import {
	type AstNode,
	childOf,
	expressionsOf,
	findAll,
	findDescendant,
	findDescendants,
	identifierName,
	identifierPosition,
	leafValue,
} from './ast-utils';

export function extractRefs(tags: JinjaTagSpan[]): RefInfo[] {
	return tags
		.filter((t): t is Extract<JinjaTagSpan, { type: 'ref' }> => t.type === 'ref')
		.map(t => ({
			model: t.model,
			line: t.line,
			col: t.col,
			modelCol: t.modelCol,
			modelEndCol: t.modelEndCol,
			jinjaCol: t.jinjaCol,
			jinjaEndCol: t.jinjaEndCol,
		}));
}

export function extractSources(tags: JinjaTagSpan[]): SourceInfo[] {
	return tags
		.filter((t): t is Extract<JinjaTagSpan, { type: 'source' }> => t.type === 'source')
		.map(t => ({
			sourceName: t.sourceName,
			tableName: t.tableName,
			line: t.line,
			col: t.col,
			sourceNameCol: t.sourceNameCol,
			sourceNameEndCol: t.sourceNameEndCol,
			tableNameCol: t.tableNameCol,
			tableNameEndCol: t.tableNameEndCol,
			jinjaCol: t.jinjaCol,
			jinjaEndCol: t.jinjaEndCol,
		}));
}

export function mapWarnings(warnings: ParseWarning[]): SqlglotWarning[] {
	return warnings.map(w => ({
		type: w.type,
		message: w.message,
		...(w.line !== undefined && { line: w.line }),
		...(w.col !== undefined && { col: w.col }),
		...(w.endCol !== undefined && { endCol: w.endCol }),
	}));
}

export function extractCtes(ast: AstPayload[], sql: string, wildcardCtes?: Array<{ name: string; line: number }>): CteInfo[] {
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

		// Columns from the body Select's expressions.
		// For UNION ALL, the body is a Union node; unwrap to the leftmost Select branch.
		let bodySelect = childOf(ast, cteIdx, 'this');
		while (bodySelect && bodySelect.node.c !== 'Select') {
			bodySelect = childOf(ast, bodySelect.index, 'this') ?? undefined;
		}
		const wildcardEntry = wildcardCtes?.find(w => w.name === name);
		const columns: ColumnInfo[] = [];
		if (wildcardEntry) {
			// qualify() expanded SELECT * — restore the wildcard using the pre-qualify line.
			columns.push({ name: '*', line: wildcardEntry.line });
		} else if (bodySelect) {
			for (const { index: exprIdx } of expressionsOf(ast, bodySelect.index)) {
				const colName = _colExprName(ast, exprIdx);
				if (!colName) continue;
			const colEntry: ColumnInfo = { name: colName, line: _colExprLine(ast, exprIdx) };
			const colPos = _colExprCol(ast, exprIdx);
			if (colPos !== undefined) colEntry.col = colPos;
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

function _finalSelectNode(ast: AstPayload[]): AstNode | undefined {
	if (ast.length === 0) return undefined;
	if (ast[0].c === 'Select') return { node: ast[0], index: 0 };
	if (ast[0].c === 'With') return childOf(ast, 0, 'this');
	return undefined;
}

// Alias.alias in serde.dump is normally an Identifier class node.
// As a fallback, plain-string leaf values (rare) are also handled.
function _colExprName(ast: AstPayload[], exprIdx: number): string | undefined {
	if (ast[exprIdx]?.c === 'Star') return undefined;
	if (ast[exprIdx]?.c === 'Alias') {
		// Case 1: alias stored as a plain string leaf (rare)
		const leaf = leafValue(ast, exprIdx, 'alias');
		if (typeof leaf === 'string' && leaf) return leaf;
		// Case 2: alias stored as an Identifier class node (normal sqlglot serialization)
		const aliasIdent = childOf(ast, exprIdx, 'alias');
		if (aliasIdent?.node.c === 'Identifier') return identifierName(ast, aliasIdent.index);
	}
	const ident = findDescendant(ast, exprIdx, 'Identifier');
	if (ident) return identifierName(ast, ident.index);
	return undefined;
}

/**
 * For an Alias expression, returns the alias Identifier index if it has position
 * metadata (user-written AS alias). Returns undefined for qualify()-synthesised aliases
 * which have no _meta.
 */
function _aliasIdentIdx(ast: AstPayload[], exprIdx: number): number | undefined {
	if (ast[exprIdx]?.c !== 'Alias') return undefined;
	const child = childOf(ast, exprIdx, 'alias');
	if (child?.node.c === 'Identifier' && child.node.m !== undefined) return child.index;
	return undefined;
}

/**
 * Returns the index of the first Identifier descendant (including the node itself)
 * that has position metadata (_meta present). Skips synthesised identifiers with no _meta.
 */
function _firstPositionedIdentIdx(ast: AstPayload[], exprIdx: number): number | undefined {
	for (const { node, index } of findDescendants(ast, exprIdx, 'Identifier')) {
		if (node.m !== undefined) return index;
	}
	return undefined;
}

function _colExprLine(ast: AstPayload[], exprIdx: number): number {
	// User-written Alias: use alias identifier position.
	// Synthesised Alias (qualify()): alias identifier has no _meta — fall through.
	const identIdx = _aliasIdentIdx(ast, exprIdx) ?? _firstPositionedIdentIdx(ast, exprIdx);
	if (identIdx !== undefined && ast[identIdx].m?.line !== undefined) return ast[identIdx].m!.line - 1;
	return 0;
}

/**
 * Returns the 0-based start column of the column name identifier in the source.
 * For Alias nodes (e.g. `count(*) as losses`), uses the alias identifier.
 * Returns undefined when position metadata is absent.
 */
function _colExprCol(ast: AstPayload[], exprIdx: number): number | undefined {
	// User-written Alias: use alias identifier position.
	// Synthesised Alias (qualify()): alias identifier has no _meta — fall through.
	const identIdx = _aliasIdentIdx(ast, exprIdx) ?? _firstPositionedIdentIdx(ast, exprIdx);
	if (identIdx === undefined) return undefined;
	const m = ast[identIdx].m;
	if (m?.col === undefined) return undefined;
	const name = identifierName(ast, identIdx);
	return name ? m.col - name.length : undefined;
}

/** Bounding box of an expression in 0-based line/col. Iterates all Identifier descendants. */
function _expressionBounds(ast: AstPayload[], exprIdx: number): { line: number; col: number; endLine: number; endCol: number } | undefined {
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

	// Include the node itself if it is an Identifier
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

function _buildSelectColumn(ast: AstPayload[], exprIdx: number): FinalSelectColumnInfo | undefined {
	const name = _colExprName(ast, exprIdx);
	if (!name) return undefined;

	const entry: FinalSelectColumnInfo = { name, line: 0, col: 0, endLine: 0, endCol: 0 };

	const bounds = _expressionBounds(ast, exprIdx);
	if (bounds) {
		entry.line = bounds.line;
		entry.col = bounds.col;
		entry.endLine = bounds.endLine;
		entry.endCol = bounds.endCol;
	}

	const exprNode = ast[exprIdx];
	if (exprNode.c === 'Alias') {
		// Alias identifier position
		const aliasIdent = childOf(ast, exprIdx, 'alias');
		if (aliasIdent?.node.c === 'Identifier') {
			const aName = identifierName(ast, aliasIdent.index);
			if (aName) {
				const pos = identifierPosition(aliasIdent.node, aName);
				if (pos) { entry.aliasLine = pos.line; entry.aliasCol = pos.col; entry.aliasEndCol = pos.endCol; }
			}
		}
		// Inner expression details
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
	const sel = _finalSelectNode(ast);
	if (!sel) return [];
	const result: ColumnInfo[] = [];
	for (const { index: exprIdx } of expressionsOf(ast, sel.index)) {
		const name = _colExprName(ast, exprIdx);
		if (name) result.push({ name, line: _colExprLine(ast, exprIdx) });
	}
	return result;
}

export function extractFinalSelect(ast: AstPayload[], sql: string): FinalSelectInfo | undefined {
	const sel = _finalSelectNode(ast);
	if (!sel) return undefined;

	const sqlLines = sql.split('\n');
	const columns: FinalSelectColumnInfo[] = [];
	for (const { index: exprIdx } of expressionsOf(ast, sel.index)) {
		const col = _buildSelectColumn(ast, exprIdx);
		if (col) columns.push(col);
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

/**
 * For each column_ref token that has a table qualifier, resolve it to the
 * matching table_ref by alias within the same CTE scope.  Mirrors the
 * post-processing pass in bridge.py.
 */
export function resolveTableRefs(tokens: TokenInfo[], ctes: CteInfo[]): void {
	const aliasedRefs = tokens.filter(
		(t): t is TableRefToken => t.type === 'table_ref' && t.alias !== undefined,
	);

	for (const tok of tokens) {
		if (tok.type !== 'column_ref' || !tok.table) continue;

		const qualifierLc = tok.table.toLowerCase();
		const colLine = tok.line;

		const containingCte = ctes.find(c => c.line <= colLine && colLine <= c.endLine);

		const scopeRefs: TableRefToken[] = containingCte
			? aliasedRefs.filter(tr => containingCte.line <= tr.line && tr.line <= containingCte.endLine)
			: aliasedRefs.filter(tr => ctes.every(c => tr.line < c.line || tr.line > c.endLine));

		// Prefer latest alias definition at or before the column.
		let best: TableRefToken | undefined;
		for (const tr of scopeRefs) {
			if ((tr.alias ?? '').toLowerCase() !== qualifierLc) continue;
			if (tr.line > colLine) continue;
			if (!best || tr.line > best.line) best = tr;
		}
		// Fallback: any alias match in scope (handles forward references).
		if (!best) {
			best = scopeRefs.find(tr => (tr.alias ?? '').toLowerCase() === qualifierLc);
		}

		if (best) tok.resolvedTableRef = best;
	}
}

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

	return tokens;
}

// ---------------------------------------------------------------------------
// Column lineage types
// ---------------------------------------------------------------------------

export interface ColumnDependency {
	column: string;
	table: string;
	schema?: string;
	database?: string;
	dbt_resource?: string;
	transformations?: Transformation[];
	via_ctes?: string[];
}

export interface TransformationBranch {
	expression?: string;
	sources: string[];
}

export interface Transformation {
	/** Namespaced id: "cte:name", "table:name", or "query" */
	id: string;
	type: 'cte' | 'table' | 'union' | 'outer_query';
	column: string;
	expression?: string;
	sources: string[];
	branches?: TransformationBranch[];
}

export interface LineageResult {
	dependencies: ColumnDependency[];
	via_ctes: string[];
	transformations: Transformation[];
}

/** Raw tree node returned by Python _dump_lineage_node. @internal */
interface LineageTreeSource {
	type: string;
	name?: string | null;
	db?: string | null;
	catalog?: string | null;
}

/** @internal */
export interface LineageTreeNode {
	name: string;
	expression: string | null;
	source: LineageTreeSource | null;
	referenceNodeName: string | null;
	downstream: LineageTreeNode[];
}

type RawLineageV2 =
    | { success: true; tree: LineageTreeNode }
    | { success: false; error: string; traceback?: string };

/** @internal */
export function walkLineageTree(tree: LineageTreeNode): LineageResult {
	const dependencies: ColumnDependency[] = [];
	const via_ctes: string[] = [];
	const transformMap = new Map<string, Transformation>();
	const cteToId = new Map<string, string>();
	const nodesWithData: Array<{ transformId: string; exprStr: string }> = [];
	const outerQuerySources = new Set<string>();
	const unionBranches = new Map<string, Array<{ expression?: string; column?: string; fullExpr?: string }>>();
	const seen = new Set<LineageTreeNode>();

	function walk(node: LineageTreeNode): void {
		if (seen.has(node)) return;
		seen.add(node);
		if (!node.name) {
			for (const c of node.downstream) walk(c);
			return;
		}

		const dotIdx = node.name.indexOf('.');

		if (dotIdx === -1) {
			if (node.referenceNodeName) {
				const branch: { expression?: string; column?: string; fullExpr?: string } = {};
				if (node.expression) {
					branch.expression = node.expression.length > 200 ? `${node.expression.slice(0, 197)}...` : node.expression;
					if (node.expression.includes(' AS ')) branch.column = node.expression.split(' AS ').at(-1)!.trim();
					branch.fullExpr = node.expression;
				}
				const list = unionBranches.get(node.referenceNodeName) ?? [];
				list.push(branch);
				unionBranches.set(node.referenceNodeName, list);
			}
			for (const c of node.downstream) walk(c);
			return;
		}

		const cteOrTable = node.name.slice(0, dotIdx).replace(/^"|"$/g, '');
		const colName = node.name.slice(dotIdx + 1).replace(/^"|"$/g, '');

		if (cteOrTable === '__lineage_final__') {
			if (node.expression) {
				for (const m of node.expression.matchAll(/\b([A-Za-z_]\w*)\./g)) {
					if (!/^\d+$/.test(m[1])) outerQuerySources.add(m[1]);
				}
			}
			for (const c of node.downstream) walk(c);
			return;
		}

		const isTable = node.source?.type === 'Table';
		const actual = isTable ? (node.source!.name ?? cteOrTable) : cteOrTable;
		const transformId = `${isTable ? 'table' : 'cte'}:${actual}`;
		const transformType: 'table' | 'cte' = isTable ? 'table' : 'cte';
		cteToId.set(actual, transformId);

		if (isTable) {
			const dep: ColumnDependency = { column: colName, table: actual };
			if (node.source!.db) dep.schema = node.source!.db;
			if (node.source!.catalog) dep.database = node.source!.catalog;
			if (!dependencies.some(d => d.column === dep.column && d.table === dep.table)) dependencies.push(dep);
		} else if (!via_ctes.includes(actual)) {
			via_ctes.push(actual);
		}

		if (node.expression) nodesWithData.push({ transformId, exprStr: node.expression });

		if (!transformMap.has(transformId)) {
			const transform: Transformation = { id: transformId, type: transformType, column: colName, sources: [] };
			if (node.expression && node.expression.trim() !== colName) {
				transform.expression = node.expression.length > 200 ? `${node.expression.slice(0, 197)}...` : node.expression;
			}
			transformMap.set(transformId, transform);
		}

		for (const c of node.downstream) walk(c);
	}

	walk(tree);

	for (const refCte of unionBranches.keys()) cteToId.set(refCte, `cte:${refCte}`);

	for (const [refCte, branches] of unionBranches) {
		if (branches.length === 0) continue;
		const transformId = `cte:${refCte}`;
		const column = branches[0].column ?? '';
		const formatted: TransformationBranch[] = branches.map(b => {
			const sourceIds = new Set<string>();
			const fullExpr = b.fullExpr ?? '';
			for (const [cteName, cteId] of cteToId) {
				if (fullExpr.includes(`${cteName}.`)) sourceIds.add(cteId);
			}
			return { expression: b.expression, sources: [...sourceIds].sort() };
		});
		transformMap.set(transformId, { id: transformId, type: 'union', column, branches: formatted, sources: [] });
	}

	const sourcesMap = new Map<string, Set<string>>();
	for (const { transformId, exprStr } of nodesWithData) {
		const srcIds = new Set<string>();
		for (const [cteName, cteId] of cteToId) {
			if (cteId !== transformId && exprStr.includes(`${cteName}.`)) srcIds.add(cteId);
		}
		if (srcIds.size > 0) {
			const existing = sourcesMap.get(transformId) ?? new Set<string>();
			for (const id of srcIds) existing.add(id);
			sourcesMap.set(transformId, existing);
		}
	}

	const transformations: Transformation[] = [];
	for (const trans of transformMap.values()) {
		if (trans.type !== 'union') trans.sources = [...(sourcesMap.get(trans.id) ?? [])].sort();
		transformations.push(trans);
	}

	if (outerQuerySources.size > 0) {
		const columnForQuery = transformations[0]?.column ?? '';
		const resolved = [...outerQuerySources].map(ref => cteToId.get(ref) ?? `table:${ref}`).sort();
		transformations.unshift({ id: 'query', type: 'outer_query', column: columnForQuery, sources: resolved });
	}

	return { dependencies, via_ctes, transformations };
}

export class FtlDocumentParser implements DocumentParser {
	private readonly _pool: PyodideWorkerPool | undefined;

	constructor(private readonly _sqlParser: SqlParser, pool?: PyodideWorkerPool) {
		this._pool = pool;
	}

	static create(pyodideDir: string, vendorDir: string, scriptsDir: string, options?: PoolOptions): FtlDocumentParser {
		const pool = new PyodideWorkerPool(pyodideDir, vendorDir, scriptsDir, options);
		return new FtlDocumentParser(pool, pool);
	}

	ready(): Promise<void> {
		return this._pool!.ready();
	}

	dispose(): void {
		this._pool?.dispose();
	}

	traceLineage(_compiledSql: string, _columnName: string, _dialect: string, _schemaJson: string): Promise<string> {
		throw new Error('traceLineage (v1) is deprecated — use traceLineageV2');
	}

	async traceLineageV2(sql: string, columnName: string, dialect: string, schemaJson: string): Promise<LineageResult | { error: string }> {
		const raw = await this._pool!.traceLineageV2(sql, columnName, dialect, schemaJson);
		const result = JSON.parse(raw) as RawLineageV2;
		if (!result.success) return { error: result.error };
		return walkLineageTree(result.tree);
	}

	async decomposeQuery(compiledSql: string, dialect: string): Promise<string> {
		return this._pool!.decomposeQuery(compiledSql, dialect);
	}

	async parse(sql: string, dialect: string, options?: ParseOptions): Promise<DocumentModel> {
		const result = await this._sqlParser.parse(sql, dialect, options?.schema);
		const ctes = extractCtes(result.ast, sql, result.wildcardCtes);
		const tokens = extractTokens(result.ast, ctes);
		resolveTableRefs(tokens, ctes);
		const refs = extractRefs(result.jinjaTags ?? []);
		const sources = extractSources(result.jinjaTags ?? []);
		// Cross-reference jinja tags ↔ table_ref tokens:
		//   - expand token endCol to cover the full {{ ... }} span
		//   - back-fill alias on RefInfo/SourceInfo from the AST token
		for (const ref of refs) {
			const tok = tokens.find((t): t is TableRefToken =>
				t.type === 'table_ref' && t.name === ref.model && t.line === ref.line && t.col === ref.jinjaCol,
			);
			if (tok && ref.jinjaEndCol !== undefined) {
				tok.endCol = ref.jinjaEndCol;
				if (tok.alias && tok.alias !== ref.model) ref.alias = tok.alias;
			}
		}
		for (const src of sources) {
			const tok = tokens.find((t): t is TableRefToken =>
				t.type === 'table_ref' && t.name === src.tableName && t.line === src.line && t.col === src.jinjaCol,
			);
			if (tok && src.jinjaEndCol !== undefined) {
				tok.endCol = src.jinjaEndCol;
				if (tok.alias && tok.alias !== src.tableName) src.alias = tok.alias;
			}
		}
		return {
			refs,
			sources,
			ctes,
			finalColumns: extractFinalColumns(result.ast),
			finalSelect: extractFinalSelect(result.ast, sql),
			tokens,
			sqlglotWarnings: mapWarnings(result.warnings),
			timing: { parseMs: result.timing.parseMs, totalMs: result.timing.totalMs },
			sqlTokens: result.sqlTokens,
			jinjaTags: result.jinjaTags,
		};
	}
}
