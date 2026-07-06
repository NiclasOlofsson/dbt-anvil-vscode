import { describe, it, expect } from 'vitest';
import { nameRangeOf, qualifierRangeOf, relationNameRangeOf, rangeOfSpan, isRelationSym } from '../../providers/sql/sym-spans';
import { sym, colSym } from '../ninja/helpers';

describe('nameRangeOf', () => {
	it('returns the last part span for a qualified column reference', () => {
		const col = colSym(0, [{ name: 'o', col: 7 }, { name: 'customer_id', col: 9 }]);
		const range = nameRangeOf(col);
		expect(range.start.character).toBe(9);
		expect(range.end.character).toBe(9 + 'customer_id'.length);
	});

	it('returns the whole span for an unqualified column reference', () => {
		const col = colSym(0, [{ name: 'customer_id', col: 7 }]);
		const range = nameRangeOf(col);
		expect(range.start.character).toBe(7);
		expect(range.end.character).toBe(7 + 'customer_id'.length);
	});

	it('narrows a column DECLARATION span to just the alias, not the whole projection', () => {
		// deriveSymbols emits a declaration's span over the WHOLE "expr AS alias"
		// clause (no partSpans) — e.g. "some_expr as customer_id" spanning col
		// 5..27. The alias comes LAST, so its own range must anchor on the span's
		// END minus its own length, never on the span's start.
		const decl = sym('column', 'customer_id', 0, 5, { modifiers: ['declaration', 'output'], endCol: 27 });
		const range = nameRangeOf(decl);
		expect(range.start.character).toBe(27 - 'customer_id'.length);
		expect(range.end.character).toBe(27);
	});
});

describe('qualifierRangeOf', () => {
	it('returns the second-to-last part span for a qualified reference', () => {
		const col = colSym(0, [{ name: 'o', col: 7 }, { name: 'customer_id', col: 9 }]);
		const range = qualifierRangeOf(col);
		expect(range).toBeDefined();
		expect(range!.start.character).toBe(7);
		expect(range!.end.character).toBe(8);
	});

	it('returns undefined for an unqualified reference', () => {
		const col = colSym(0, [{ name: 'customer_id', col: 7 }]);
		expect(qualifierRangeOf(col)).toBeUndefined();
	});
});

describe('relationNameRangeOf', () => {
	it('narrows a CTE DECLARATION span to just the name, not the whole clause', () => {
		// deriveSymbols emits a CTE declaration's span over the WHOLE "name AS
		// (body)" clause — e.g. "my_cte as (select 1)" spanning col 5..26. The
		// name comes FIRST, so its own range must anchor on the span's START,
		// never on its end.
		const decl = sym('cte', 'my_cte', 0, 5, { modifiers: ['declaration'], endCol: 26 });
		const range = relationNameRangeOf(decl);
		expect(range.start.character).toBe(5);
		expect(range.end.character).toBe(5 + 'my_cte'.length);
	});

	it('passes a relation REFERENCE span through unchanged', () => {
		const ref = sym('table', 'orders', 1, 5);
		const range = relationNameRangeOf(ref);
		expect(range).toEqual(rangeOfSpan(ref.span));
	});
});

describe('isRelationSym', () => {
	it('is true for table/cte/subquery/lateral, false otherwise', () => {
		expect(isRelationSym(sym('table', 'orders', 0, 0))).toBe(true);
		expect(isRelationSym(sym('cte', 'my_cte', 0, 0))).toBe(true);
		expect(isRelationSym(sym('subquery', 'x', 0, 0))).toBe(true);
		expect(isRelationSym(sym('lateral', 'x', 0, 0))).toBe(true);
		expect(isRelationSym(sym('alias', 'x', 0, 0))).toBe(false);
		expect(isRelationSym(sym('column', 'x', 0, 0))).toBe(false);
	});
});
