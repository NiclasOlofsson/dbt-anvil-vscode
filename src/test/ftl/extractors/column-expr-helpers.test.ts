import { describe, expect, it } from 'vitest';
import type { AstPayload } from '../../../ftl/parse-result';
import {
	MAX_EXPR_LEN,
	extractColumnExprName,
	getColumnExprMetadata,
	truncateExpression,
} from '../../../ftl/extractors/column-expr-helpers';

// AST shape mirrors the bridge's serde.dump output: a flat array of nodes whose
// `i`/`k` fields point upward to a parent index + slot. `m` carries source
// position; nodes without `m` were synthesised by sqlglot's qualify() pass.

describe('truncateExpression', () => {
	it('returns the input unchanged when within the limit', () => {
		const expr = 'SELECT a + b';
		expect(truncateExpression(expr)).toBe(expr);
	});

	it('truncates oversized expressions and adds an ellipsis', () => {
		const expr = 'x'.repeat(MAX_EXPR_LEN + 50);
		const out = truncateExpression(expr);
		expect(out.length).toBe(MAX_EXPR_LEN);
		expect(out.endsWith('...')).toBe(true);
	});
});

describe('extractColumnExprName', () => {
	it('returns undefined for a bare Star', () => {
		const ast: AstPayload[] = [{ c: 'Star' }];
		expect(extractColumnExprName(ast, 0)).toBeUndefined();
	});

	it('returns "*" for a qualified Star (cp.*)', () => {
		const ast: AstPayload[] = [
			{ c: 'Column' },                       // [0]
			{ c: 'Star', i: 0, k: 'this' },        // [1]
		];
		expect(extractColumnExprName(ast, 0)).toBe('*');
	});

	it('returns the alias name for an Alias with Identifier alias', () => {
		const ast: AstPayload[] = [
			{ c: 'Alias' },                                              // [0]
			{ c: 'Column', i: 0, k: 'this' },                            // [1]
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 1, col: 3 } }, // [2]
			{ i: 2, k: 'this', v: 'id' },                                // [3]
			{ c: 'Identifier', i: 0, k: 'alias', m: { line: 1, col: 9 } }, // [4]
			{ i: 4, k: 'this', v: 'user_id' },                           // [5]
		];
		expect(extractColumnExprName(ast, 0)).toBe('user_id');
	});

	it('returns the alias name when alias is a string-leaf (legacy shape)', () => {
		const ast: AstPayload[] = [
			{ c: 'Alias' },                            // [0]
			{ c: 'Column', i: 0, k: 'this' },          // [1]
			{ i: 0, k: 'alias', v: 'totals' },         // [2]  string-leaf alias
		];
		expect(extractColumnExprName(ast, 0)).toBe('totals');
	});

	it('falls back to the first descendant Identifier for a bare Column', () => {
		const ast: AstPayload[] = [
			{ c: 'Column' },                                              // [0]
			{ c: 'Identifier', i: 0, k: 'this', m: { line: 1, col: 5 } }, // [1]
			{ i: 1, k: 'this', v: 'amount' },                            // [2]
		];
		expect(extractColumnExprName(ast, 0)).toBe('amount');
	});

	it('returns undefined when no Identifier descendant exists', () => {
		const ast: AstPayload[] = [{ c: 'Literal' }];
		expect(extractColumnExprName(ast, 0)).toBeUndefined();
	});
});

describe('getColumnExprMetadata', () => {
	it('returns line/col taken from the alias identifier when present', () => {
		const ast: AstPayload[] = [
			{ c: 'Alias' },                                                // [0]
			{ c: 'Column', i: 0, k: 'this' },                              // [1]
			{ c: 'Identifier', i: 1, k: 'this', m: { line: 2, col: 6 } },  // [2]  inner id "amt"
			{ i: 2, k: 'this', v: 'amt' },                                 // [3]
			{ c: 'Identifier', i: 0, k: 'alias', m: { line: 2, col: 16 } }, // [4]  alias id "total"
			{ i: 4, k: 'this', v: 'total' },                               // [5]
		];
		const meta = getColumnExprMetadata(ast, 0);
		expect(meta.name).toBe('total');
		// line is 0-based (Pyodide returns 1-based, helper subtracts 1).
		expect(meta.line).toBe(1);
		// col is identifier-start (m.col is end position; helper subtracts identifier length).
		expect(meta.col).toBe(16 - 'total'.length);
	});

	it('falls back to the first positioned identifier for a bare Column', () => {
		const ast: AstPayload[] = [
			{ c: 'Column' },                                              // [0]
			{ c: 'Identifier', i: 0, k: 'this', m: { line: 3, col: 9 } }, // [1]
			{ i: 1, k: 'this', v: 'amount' },                            // [2]
		];
		const meta = getColumnExprMetadata(ast, 0);
		expect(meta.name).toBe('amount');
		expect(meta.line).toBe(2);
		expect(meta.col).toBe(9 - 'amount'.length);
	});

	it('returns line=0 and col=undefined when no positioned identifier exists', () => {
		// Star: no name, no position.
		const ast: AstPayload[] = [{ c: 'Star' }];
		const meta = getColumnExprMetadata(ast, 0);
		expect(meta.name).toBeUndefined();
		expect(meta.line).toBe(0);
		expect(meta.col).toBeUndefined();
	});

	it('skips synthesised identifiers with no `_meta`', () => {
		// Synthesised by qualify(): inner Column has Identifier WITHOUT `m`.
		// Outer Alias has a positioned Identifier — that should win.
		const ast: AstPayload[] = [
			{ c: 'Alias' },                                            // [0]
			{ c: 'Column', i: 0, k: 'this' },                          // [1]
			{ c: 'Identifier', i: 1, k: 'this' },                      // [2]  no `m`
			{ i: 2, k: 'this', v: 'qualified' },                       // [3]
			{ c: 'Identifier', i: 0, k: 'alias', m: { line: 5, col: 12 } }, // [4]
			{ i: 4, k: 'this', v: 'out' },                             // [5]
		];
		const meta = getColumnExprMetadata(ast, 0);
		expect(meta.name).toBe('out');
		expect(meta.line).toBe(4);
		expect(meta.col).toBe(12 - 'out'.length);
	});
});
