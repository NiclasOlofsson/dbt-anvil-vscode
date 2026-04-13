import { describe, it, expect } from 'vitest';
import type { AstPayload } from '../../ftl/parse-result';
import {
    findAll,
    childOf,
    expressionsOf,
    leafValue,
    identifierName,
    identifierPosition,
    isDescendantOf,
    findDescendant,
    findDescendants,
} from '../../ftl/ast-utils';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * Minimal flat array representing:
 *
 *   WITH orders AS (SELECT …), items AS (SELECT …) SELECT …
 *
 * Simplified structure — bodies collapsed to a single Select node.
 */
const withAst: AstPayload[] = [
    { c: 'With' },                                        // [0]
    { c: 'CTE', i: 0, k: 'expressions', a: true },       // [1]  orders CTE
    { c: 'Select', i: 1, k: 'this' },                    // [2]  orders body
    { c: 'TableAlias', i: 1, k: 'alias' },               // [3]
    { c: 'Identifier', i: 3, k: 'this', m: { line: 1, col: 9 } }, // [4]  "orders"
    { i: 4, k: 'this', v: 'orders' },                    // [5]
    { c: 'CTE', i: 0, k: 'expressions', a: true },       // [6]  items CTE
    { c: 'Select', i: 6, k: 'this' },                    // [7]  items body
    { c: 'TableAlias', i: 6, k: 'alias' },               // [8]
    { c: 'Identifier', i: 8, k: 'this', m: { line: 1, col: 16 } }, // [9]  "items"
    { i: 9, k: 'this', v: 'items' },                     // [10]
    { c: 'Select', i: 0, k: 'this' },                    // [11] final SELECT
];

/**
 * Minimal flat array representing a SELECT with two Column children and a From.
 */
const selectAst: AstPayload[] = [
    { c: 'Select' },                                              // [0]
    { c: 'Column', i: 0, k: 'expressions', a: true },            // [1]
    { c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 3 } }, // [2]  "id"
    { i: 2, k: 'this', v: 'id' },                                // [3]
    { c: 'Column', i: 0, k: 'expressions', a: true },            // [4]
    { c: 'Identifier', i: 4, k: 'this', m: { line: 1, col: 11 } }, // [5]  "name"
    { i: 5, k: 'this', v: 'name' },                              // [6]
    { c: 'From', i: 0, k: 'from' },                              // [7]
    { c: 'Table', i: 7, k: 'this' },                             // [8]
    { c: 'Identifier', i: 8, k: 'this', m: { line: 1, col: 22 } }, // [9]  "users"
    { i: 9, k: 'this', v: 'users' },                             // [10]
];

/**
 * Deeper nesting to exercise `isDescendantOf` / `findDescendants` edges.
 *
 * With[0]
 *   CTE[1]
 *     Select[2]
 *       Column[3]
 *         Identifier[4] "id"
 *         leaf[5]
 *     TableAlias[6]
 *   Select[7]  ← final SELECT (not under CTE)
 *     Column[8]
 */
const deepAst: AstPayload[] = [
    { c: 'With' },                                         // [0]
    { c: 'CTE', i: 0, k: 'expressions', a: true },        // [1]
    { c: 'Select', i: 1, k: 'this' },                     // [2]
    { c: 'Column', i: 2, k: 'expressions', a: true },     // [3]
    { c: 'Identifier', i: 3, k: 'this', m: { line: 2, col: 20 } }, // [4]
    { i: 4, k: 'this', v: 'id' },                         // [5]
    { c: 'TableAlias', i: 1, k: 'alias' },                // [6]
    { c: 'Select', i: 0, k: 'this' },                     // [7]
    { c: 'Column', i: 7, k: 'expressions', a: true },     // [8]
];

// ---------------------------------------------------------------------------
// findAll
// ---------------------------------------------------------------------------

describe('findAll', () => {
    it('returns all nodes matching the class name', () => {
        const result = findAll(withAst, 'CTE');
        expect(result).toHaveLength(2);
        expect(result[0].index).toBe(1);
        expect(result[1].index).toBe(6);
    });

    it('returns multiple Select nodes', () => {
        const result = findAll(withAst, 'Select');
        expect(result).toHaveLength(3);
        expect(result.map(r => r.index)).toEqual([2, 7, 11]);
    });

    it('returns empty array when no match', () => {
        expect(findAll(withAst, 'Column')).toHaveLength(0);
    });

    it('does not match leaf-value entries without c field', () => {
        // [5] { i: 4, k: 'this', v: 'orders' } has no c
        const result = findAll(withAst, 'undefined');
        expect(result).toHaveLength(0);
    });
});

// ---------------------------------------------------------------------------
// childOf
// ---------------------------------------------------------------------------

describe('childOf', () => {
    it('returns the body Select of a CTE', () => {
        const result = childOf(withAst, 1, 'this');
        expect(result?.index).toBe(2);
        expect(result?.node.c).toBe('Select');
    });

    it('returns the TableAlias of a CTE', () => {
        const result = childOf(withAst, 1, 'alias');
        expect(result?.index).toBe(3);
        expect(result?.node.c).toBe('TableAlias');
    });

    it('returns undefined for a missing key', () => {
        expect(childOf(withAst, 1, 'from')).toBeUndefined();
    });

    it('does not match leaf entries (no c field)', () => {
        // [5] is a leaf under [4], not [3]
        expect(childOf(withAst, 3, 'this')).not.toBeUndefined();
        // But leafValue for [3] shouldn't be returned here (no c on leaf)
        const result = childOf(withAst, 4, 'this');
        expect(result).toBeUndefined(); // leaf node [5] has no c → not returned
    });
});

// ---------------------------------------------------------------------------
// expressionsOf
// ---------------------------------------------------------------------------

describe('expressionsOf', () => {
    it('returns all CTE expressions under With', () => {
        const result = expressionsOf(withAst, 0);
        expect(result).toHaveLength(2);
        expect(result[0].index).toBe(1);
        expect(result[1].index).toBe(6);
    });

    it('returns Column expressions under Select', () => {
        const result = expressionsOf(selectAst, 0);
        expect(result).toHaveLength(2);
        expect(result[0].index).toBe(1);
        expect(result[1].index).toBe(4);
    });

    it('returns empty for a non-array child (from)', () => {
        // From is a direct child but not an array element (a !== true)
        expect(expressionsOf(selectAst, 0, 'from')).toHaveLength(0);
    });

    it('accepts an explicit key', () => {
        const result = expressionsOf(withAst, 0, 'expressions');
        expect(result).toHaveLength(2);
    });
});

// ---------------------------------------------------------------------------
// leafValue
// ---------------------------------------------------------------------------

describe('leafValue', () => {
    it('reads the string value from a leaf child', () => {
        expect(leafValue(withAst, 4, 'this')).toBe('orders');
    });

    it('reads values on deeply nested nodes', () => {
        expect(leafValue(withAst, 9, 'this')).toBe('items');
    });

    it('returns undefined for a non-existent key', () => {
        expect(leafValue(withAst, 4, 'missing')).toBeUndefined();
    });

    it('returns undefined when matching node has no v field', () => {
        // node [4] has c='Identifier', k='this', i=3 — but has no v
        expect(leafValue(withAst, 3, 'this')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// identifierName
// ---------------------------------------------------------------------------

describe('identifierName', () => {
    it('returns the identifier string for a named identifier node', () => {
        expect(identifierName(withAst, 4)).toBe('orders');
        expect(identifierName(withAst, 9)).toBe('items');
    });

    it('returns the column name from selectAst', () => {
        expect(identifierName(selectAst, 2)).toBe('id');
        expect(identifierName(selectAst, 5)).toBe('name');
        expect(identifierName(selectAst, 9)).toBe('users');
    });

    it('returns undefined for a non-Identifier class node', () => {
        // Use a node index that has no 'this' leaf child with a string value
        expect(identifierName(withAst, 0)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// identifierPosition
// ---------------------------------------------------------------------------

describe('identifierPosition', () => {
    it('converts 1-based line and exclusive-end col to 0-based', () => {
        // node [4]: m = { line: 1, col: 9 }, name = 'orders' (len 6)
        // line_0 = 0, endCol_0 = 8, col_0 = 8 - 6 = 2
        const pos = identifierPosition(withAst[4], 'orders');
        expect(pos).toEqual({ line: 0, col: 2, endCol: 8 });
    });

    it('handles a two-char name', () => {
        // node [2] in selectAst: m = { line: 1, col: 3 }, name = 'id' (len 2)
        // endCol_0 = 2, col_0 = 0
        const pos = identifierPosition(selectAst[2], 'id');
        expect(pos).toEqual({ line: 0, col: 0, endCol: 2 });
    });

    it('handles a 4-char name on col 11', () => {
        // node [5] in selectAst: m = { line: 1, col: 11 }, name = 'name' (len 4)
        // endCol_0 = 10, col_0 = 6
        const pos = identifierPosition(selectAst[5], 'name');
        expect(pos).toEqual({ line: 0, col: 6, endCol: 10 });
    });

    it('returns undefined when m is absent', () => {
        const node: AstPayload = { c: 'Identifier', i: 0, k: 'this' };
        expect(identifierPosition(node, 'x')).toBeUndefined();
    });

    it('returns undefined when m.line is absent', () => {
        const node: AstPayload = { c: 'Identifier', i: 0, k: 'this', m: { col: 5 } };
        expect(identifierPosition(node, 'x')).toBeUndefined();
    });

    it('returns undefined when m.col is absent', () => {
        const node: AstPayload = { c: 'Identifier', i: 0, k: 'this', m: { line: 1 } };
        expect(identifierPosition(node, 'x')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// isDescendantOf
// ---------------------------------------------------------------------------

describe('isDescendantOf', () => {
    it('returns true for immediate child', () => {
        // CTE[1].i === 0 (With)
        expect(isDescendantOf(deepAst, 1, 0)).toBe(true);
    });

    it('returns true for deeply nested descendant', () => {
        // Identifier[4] → Column[3] → Select[2] → CTE[1] → With[0]
        expect(isDescendantOf(deepAst, 4, 0)).toBe(true);
        expect(isDescendantOf(deepAst, 4, 1)).toBe(true);
        expect(isDescendantOf(deepAst, 4, 2)).toBe(true);
    });

    it('returns false for a node in a sibling subtree', () => {
        // Column[8] is under Select[7], not under CTE[1]
        expect(isDescendantOf(deepAst, 8, 1)).toBe(false);
    });

    it('returns false for the root node itself', () => {
        // With[0] has no parent
        expect(isDescendantOf(deepAst, 0, 0)).toBe(false);
    });

    it('returns false for ancestor check against itself', () => {
        expect(isDescendantOf(deepAst, 3, 3)).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// findDescendant
// ---------------------------------------------------------------------------

describe('findDescendant', () => {
    it('finds the first Identifier under the CTE', () => {
        const result = findDescendant(deepAst, 1, 'Identifier');
        expect(result?.index).toBe(4);
    });

    it('finds the Select body under the CTE', () => {
        const result = findDescendant(deepAst, 1, 'Select');
        expect(result?.index).toBe(2);
    });

    it('finds the first Select under With (CTE body, not final Select)', () => {
        const result = findDescendant(deepAst, 0, 'Select');
        expect(result?.index).toBe(2);
    });

    it('returns undefined when class not found under ancestor', () => {
        // No Identifier directly under the final Select[7]
        expect(findDescendant(deepAst, 7, 'Identifier')).toBeUndefined();
    });

    it('returns undefined for an empty ast', () => {
        expect(findDescendant([], 0, 'Select')).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// findDescendants
// ---------------------------------------------------------------------------

describe('findDescendants', () => {
    it('finds only Columns under With (all of them)', () => {
        const result = findDescendants(deepAst, 0, 'Column');
        expect(result).toHaveLength(2);
        expect(result.map(r => r.index)).toEqual([3, 8]);
    });

    it('finds only the Column that belongs to the CTE subtree', () => {
        const result = findDescendants(deepAst, 1, 'Column');
        expect(result).toHaveLength(1);
        expect(result[0].index).toBe(3);
    });

    it('finds both Select nodes under With', () => {
        const result = findDescendants(deepAst, 0, 'Select');
        expect(result).toHaveLength(2);
        expect(result.map(r => r.index)).toEqual([2, 7]);
    });

    it('returns empty when nothing matches', () => {
        expect(findDescendants(deepAst, 0, 'Window')).toHaveLength(0);
    });

    it('returns empty for an empty ast', () => {
        expect(findDescendants([], 0, 'Column')).toHaveLength(0);
    });
});
