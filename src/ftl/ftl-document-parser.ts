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

export function extractCtes(ast: AstPayload[], sql: string): CteInfo[] {
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
        const bodySelect = childOf(ast, cteIdx, 'this');
        const columns: ColumnInfo[] = [];
        if (bodySelect) {
            for (const { index: exprIdx } of expressionsOf(ast, bodySelect.index)) {
                const colName = _colExprName(ast, exprIdx);
                if (!colName) continue;
                columns.push({ name: colName, line: _colExprLine(ast, exprIdx) });
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

function _colExprLine(ast: AstPayload[], exprIdx: number): number {
    const ident = findDescendant(ast, exprIdx, 'Identifier');
    if (ident?.node.m?.line !== undefined) return ident.node.m.line - 1;
    const m = ast[exprIdx]?.m;
    return m?.line !== undefined ? m.line - 1 : 0;
}

/** Bounding box of an expression in 0-based line/col. Iterates all Identifier descendants. */
function _expressionBounds(ast: AstPayload[], exprIdx: number): { line: number; col: number; endLine: number; endCol: number } | undefined {
    let minLine = Infinity, minCol = Infinity;
    let maxLine = -Infinity, maxCol = -Infinity;

    const update = (node: AstPayload, name: string) => {
        if (node.m?.line === undefined || node.m.col === undefined) return;
        const line = node.m.line - 1;
        const endCol = node.m.col - 1;
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
 * Extract all token references from the AST.
 *
 * Emits three token kinds mirroring the bridge:
 *   - column_ref  : every Column node (with optional table qualifier)
 *   - column_def  : every Alias node (the alias identifier becomes the definition site)
 *   - table_ref   : every Table node in FROM/JOIN, plus one per CTE definition site
 *
 * Note: resolvedTableRef cross-linking is not performed here — that pass
 * requires scope context that will be added later.
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
                    }
                }
            }
        }

        tokens.push(token);
    }

    return tokens;
}

export class FtlDocumentParser implements DocumentParser {
    private readonly _pool: PyodideWorkerPool | undefined;

    constructor(private readonly _sqlParser: SqlParser, pool?: PyodideWorkerPool) {
        this._pool = pool;
    }

    static create(pyodideDir: string, vendorDir: string, options?: PoolOptions): FtlDocumentParser {
        const pool = new PyodideWorkerPool(pyodideDir, vendorDir, options);
        return new FtlDocumentParser(pool, pool);
    }

    ready(): Promise<void> {
        return this._pool!.ready();
    }

    dispose(): void {
        this._pool?.dispose();
    }

    async parse(sql: string, dialect: string, options?: ParseOptions): Promise<DocumentModel> {
        const result = await this._sqlParser.parse(sql, dialect, options?.schema);
        const ctes = extractCtes(result.ast, sql);
        return {
            refs: extractRefs(result.jinjaTags ?? []),
            sources: extractSources(result.jinjaTags ?? []),
            ctes,
            finalColumns: extractFinalColumns(result.ast),
            finalSelect: extractFinalSelect(result.ast, sql),
            tokens: extractTokens(result.ast, ctes),
            sqlglotWarnings: mapWarnings(result.warnings),
            timing: { parseMs: result.timing.parseMs, totalMs: result.timing.totalMs },
        };
    }
}
