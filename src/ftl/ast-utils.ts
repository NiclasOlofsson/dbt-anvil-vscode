import type { AstPayload } from './parse-result';

export interface AstNode {
    node: AstPayload;
    index: number;
}

export interface NodePosition {
    line: number;   // 0-based
    col: number;    // 0-based inclusive start
    endCol: number; // 0-based exclusive end
}

/** All nodes whose class name matches `className`. */
export function findAll(ast: AstPayload[], className: string): AstNode[] {
    const out: AstNode[] = [];
    for (let i = 0; i < ast.length; i++) {
        if (ast[i].c === className) out.push({ node: ast[i], index: i });
    }
    return out;
}

/**
 * Direct class-node child of `parentIdx` with arg key `key`.
 * Matches entries that have both `i === parentIdx` and `k === key` and `c` present.
 */
export function childOf(ast: AstPayload[], parentIdx: number, key: string): AstNode | undefined {
    for (let i = 0; i < ast.length; i++) {
        const n = ast[i];
        if (n.i === parentIdx && n.k === key && n.c !== undefined) {
            return { node: n, index: i };
        }
    }
    return undefined;
}

/**
 * All array children of `parentIdx` for a given arg key (default `'expressions'`).
 * Returns entries with `i === parentIdx`, `k === key`, and `a === true`.
 */
export function expressionsOf(ast: AstPayload[], parentIdx: number, key = 'expressions'): AstNode[] {
    const out: AstNode[] = [];
    for (let i = 0; i < ast.length; i++) {
        const n = ast[i];
        if (n.i === parentIdx && n.k === key && n.a === true) {
            out.push({ node: n, index: i });
        }
    }
    return out;
}

/**
 * Read a primitive leaf value from a child entry `{i: parentIdx, k: key, v: ...}`.
 * Returns `undefined` when no matching leaf exists.
 */
export function leafValue(ast: AstPayload[], parentIdx: number, key: string): unknown {
    for (let i = 0; i < ast.length; i++) {
        const n = ast[i];
        if (n.i === parentIdx && n.k === key && n.v !== undefined) {
            return n.v;
        }
    }
    return undefined;
}

/**
 * Read the string name from an Identifier node at `identifierIdx`.
 * The name is stored as a leaf child with key `'this'`.
 */
export function identifierName(ast: AstPayload[], identifierIdx: number): string | undefined {
    const v = leafValue(ast, identifierIdx, 'this');
    return typeof v === 'string' ? v : undefined;
}

/**
 * Compute 0-based position for an Identifier node given its resolved name.
 * `m.col` is 1-based exclusive end; start = endCol - name.length.
 * Returns `undefined` when the node has no position info.
 */
export function identifierPosition(identNode: AstPayload, name: string): NodePosition | undefined {
    if (identNode.m?.line === undefined || identNode.m.col === undefined) return undefined;
    const endCol = identNode.m.col - 1;   // convert to 0-based exclusive end
    return {
        line: identNode.m.line - 1,
        col: endCol - name.length,
        endCol,
    };
}

/** True when the node at `idx` is a descendant of `ancestorIdx`. */
export function isDescendantOf(ast: AstPayload[], idx: number, ancestorIdx: number): boolean {
    let cur: number | undefined = ast[idx]?.i;
    while (cur !== undefined) {
        if (cur === ancestorIdx) return true;
        cur = ast[cur]?.i;
    }
    return false;
}

/** First descendant of `ancestorIdx` that has class `className`. */
export function findDescendant(ast: AstPayload[], ancestorIdx: number, className: string): AstNode | undefined {
    for (let i = 0; i < ast.length; i++) {
        if (ast[i].c === className && isDescendantOf(ast, i, ancestorIdx)) {
            return { node: ast[i], index: i };
        }
    }
    return undefined;
}

/** All descendants of `ancestorIdx` that have class `className`. */
export function findDescendants(ast: AstPayload[], ancestorIdx: number, className: string): AstNode[] {
    const out: AstNode[] = [];
    for (let i = 0; i < ast.length; i++) {
        if (ast[i].c === className && isDescendantOf(ast, i, ancestorIdx)) {
            out.push({ node: ast[i], index: i });
        }
    }
    return out;
}
