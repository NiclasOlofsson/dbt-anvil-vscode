import { describe, it, expect } from 'vitest';
import { nameRangeOf, qualifierRangeOf, relationNameRangeOf, rangeOfSpan, isRelationSym, symMatchesCte, symsMatchSameCte } from '../../providers/sql/sym-spans';
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

	it('narrows an ALIASED CTE reference span to just the name, excluding the alias', () => {
		// Verified empirically: `FROM orders o` gives the relation Sym a span
		// covering "orders o" (through the alias), not just "orders" — a CTE
		// reference behaves the same way, e.g. "my_cte x" spanning col 5..13.
		// Narrowing is keyed on Sym.alias's presence, not just "is this a cte" —
		// an unaliased reference is already name-only (see the next test).
		const ref = sym('cte', 'my_cte', 0, 5, { endCol: 13, alias: { name: 'x', line: 0, col: 12 } });
		const range = relationNameRangeOf(ref);
		expect(range.start.character).toBe(5);
		expect(range.end.character).toBe(5 + 'my_cte'.length);
	});

	it('does not narrow an unaliased CTE reference (already name-only, and narrowing via name.length would cut off a quoted name\'s closing delimiter)', () => {
		// A quoted CTE name's raw token width (delimiters included) exceeds
		// `Sym.name`'s length (delimiters stripped) — narrowing via name.length
		// would wrongly shrink an already-correct span for this case.
		const ref = sym('cte', 'My Cte', 0, 5, { endCol: 13 }); // e.g. `"My Cte"`, 8 raw chars, name.length 6
		const range = relationNameRangeOf(ref);
		expect(range.start.character).toBe(5);
		expect(range.end.character).toBe(13); // unchanged — NOT 5 + 'My Cte'.length (11)
	});

	it('passes an unaliased CTE reference span through unchanged (already name-only)', () => {
		const ref = sym('cte', 'my_cte', 0, 5);
		const range = relationNameRangeOf(ref);
		expect(range).toEqual(rangeOfSpan(ref.span));
	});

	it('passes a table/subquery/lateral relation span through unchanged', () => {
		// A ref()/source()-backed table Sym's name doesn't match its source text
		// width (a jinja tag renders as a different width than the resolved table
		// name) — unlike a CTE name, which is always a literal SQL identifier.
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

describe('symMatchesCte / symsMatchSameCte', () => {
	// Regression coverage for a real, live bug: Sym.name for a CTE is sqllens's
	// displayName (the DECLARED spelling — e.g. written "MyCte" — copied onto
	// every Sym for that CTE regardless of how a given reference was typed).
	// CteInfo.name (this extension's extractCtes) instead folds through
	// normName/foldIdentifier for dialect casing (e.g. Snowflake uppercases
	// unquoted identifiers to "MYCTE"). A name-string comparison between the
	// two silently fails for any CTE name with a non-lowercase letter — these
	// helpers compare structural anchors instead, immune to that mismatch.

	it('matches a reference Sym to its CteInfo by anchor position, even when the folded names disagree', () => {
		// Declared "MyCte" (Sym.name, displayName); CteInfo.name folded to "MYCTE"
		// (Snowflake uppercases unquoted identifiers) — deliberately DIFFERENT strings.
		const cte = { name: 'MYCTE', line: 0, col: 5, endLine: 0, endCol: 30, columns: [] };
		const declSym = sym('cte', 'MyCte', 0, 5, { modifiers: ['declaration'] });
		const refSym = sym('cte', 'MyCte', 1, 14, { definitionOf: cte });

		expect(symMatchesCte(declSym, cte)).toBe(true);
		expect(symMatchesCte(refSym, cte)).toBe(true);
	});

	it('does not match a Sym anchored at a different position', () => {
		const cte = { name: 'MYCTE', line: 0, col: 5, endLine: 0, endCol: 30, columns: [] };
		const otherCte = { name: 'OTHER', line: 5, col: 5, endLine: 5, endCol: 30, columns: [] };
		const refToOther = sym('cte', 'Other', 1, 14, { definitionOf: otherCte });

		expect(symMatchesCte(refToOther, cte)).toBe(false);
	});

	it('matches two reference Syms for the same CTE, even when their folded names would disagree', () => {
		const declSym = sym('cte', 'MyCte', 0, 5, { modifiers: ['declaration'] });
		const ref1 = sym('cte', 'MyCte', 1, 14, { definitionOf: declSym });
		const ref2 = sym('cte', 'MyCte', 2, 20, { definitionOf: declSym });

		expect(symsMatchSameCte(declSym, ref1)).toBe(true);
		expect(symsMatchSameCte(ref1, ref2)).toBe(true);
	});

	it('does not match two references to different CTEs', () => {
		const declA = sym('cte', 'A', 0, 5, { modifiers: ['declaration'] });
		const declB = sym('cte', 'B', 5, 5, { modifiers: ['declaration'] });
		const refA = sym('cte', 'A', 1, 14, { definitionOf: declA });
		const refB = sym('cte', 'B', 6, 14, { definitionOf: declB });

		expect(symsMatchSameCte(refA, refB)).toBe(false);
	});

	it('returns false for a non-cte Sym or an unresolved reference', () => {
		const cte = { name: 'MYCTE', line: 0, col: 5, endLine: 0, endCol: 30, columns: [] };
		expect(symMatchesCte(sym('table', 'orders', 0, 0), cte)).toBe(false);
		expect(symMatchesCte(sym('cte', 'MyCte', 1, 14), cte)).toBe(false); // no definitionOf set
	});
});
