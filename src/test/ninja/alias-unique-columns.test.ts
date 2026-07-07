import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model } from './helpers';
import { aliasUniqueColumnsRule } from '../../ninja/rules/alias-unique-columns';
import type { FinalSelectInfo, FinalSelectColumnInfo, ColumnInfo } from '../../services/parse-service';

const RULE = 'ninja.alias.unique-columns';

// ── Helpers ───────────────────────────────────────────────────────────────────

function finalCol(
	name: string,
	line: number,
	col: number,
	endCol: number,
	aliasLine?: number,
	aliasCol?: number,
	aliasEndCol?: number,
): FinalSelectColumnInfo {
	return { name, line, col, endLine: aliasLine ?? line, endCol: aliasEndCol ?? endCol, aliasLine, aliasCol, aliasEndCol };
}

function makeSelect(columns: FinalSelectColumnInfo[]): FinalSelectInfo {
	return { line: 0, col: 0, endLine: 0, endCol: 100, columns };
}

function checkFinalSelect(sql: string, columns: FinalSelectColumnInfo[]) {
	const doc = mockDocument(sql);
	const m = model({ finalSelect: makeSelect(columns) });
	return aliasUniqueColumnsRule.check({ model: m, document: doc, config: cfg() });
}

function checkFinalColumns(sql: string, columns: ColumnInfo[]) {
	const doc = mockDocument(sql);
	const m = model({ finalColumns: columns });
	return aliasUniqueColumnsRule.check({ model: m, document: doc, config: cfg() });
}

// ── Tests: finalSelect path ───────────────────────────────────────────────────

describe(RULE, () => {
	describe('finalSelect path', () => {
		it('passes unique column names', () => {
			const v = checkFinalSelect('select a, b from t', [
				finalCol('a', 0, 7, 8),
				finalCol('b', 0, 10, 11),
			]);
			expect(v).toHaveLength(0);
		});

		it('flags duplicate column name', () => {
			const v = checkFinalSelect('select a, a from t', [
				finalCol('a', 0, 7, 8),
				finalCol('a', 0, 10, 11),
			]);
			expect(v).toHaveLength(1);
			expect(v[0].rule).toBe(RULE);
			expect(v[0].message).toContain('\'a\'');
		});

		it('flags only the second occurrence, not the first', () => {
			const v = checkFinalSelect('select a, a from t', [
				finalCol('a', 0, 7, 8),
				finalCol('a', 0, 10, 11),
			]);
			expect(v).toHaveLength(1);
			// First occurrence is at col 7; violation should point at col 10 (second).
			expect(v[0].range.start.character).toBe(10);
		});

		it('flags third occurrence too', () => {
			const v = checkFinalSelect('select a, a, a from t', [
				finalCol('a', 0, 7, 8),
				finalCol('a', 0, 10, 11),
				finalCol('a', 0, 13, 14),
			]);
			expect(v).toHaveLength(2);
		});

		it('comparison is case-insensitive', () => {
			const v = checkFinalSelect('select user_id, USER_ID from t', [
				finalCol('user_id', 0, 7, 14),
				finalCol('USER_ID', 0, 16, 23),
			]);
			expect(v).toHaveLength(1);
			expect(v[0].message).toContain('USER_ID');
		});

		it('passes empty column list', () => {
			const v = checkFinalSelect('select 1', []);
			expect(v).toHaveLength(0);
		});

		it('passes single column', () => {
			const v = checkFinalSelect('select a from t', [finalCol('a', 0, 7, 8)]);
			expect(v).toHaveLength(0);
		});

		it('uses alias position when explicit AS alias is present', () => {
			// Column: "id AS user_id" — alias at line 0, col 6..13
			const v = checkFinalSelect('select id AS user_id, id AS user_id from t', [
				finalCol('user_id', 0, 7, 14, 0, 13, 20),
				finalCol('user_id', 0, 22, 29, 0, 29, 36),
			]);
			expect(v).toHaveLength(1);
			// Violation should point at alias position (aliasCol = 29).
			expect(v[0].range.start.character).toBe(29);
		});

		it('flags duplicates across different lines', () => {
			const v = checkFinalSelect('select\n    a,\n    a\nfrom t', [
				finalCol('a', 1, 4, 5),
				finalCol('a', 2, 4, 5),
			]);
			expect(v).toHaveLength(1);
			expect(v[0].range.start.line).toBe(2);
		});

		it('does not flag distinct column names with same expression', () => {
			// same expression, different aliases
			const v = checkFinalSelect('select id AS a, id AS b from t', [
				finalCol('a', 0, 7, 8, 0, 13, 14),
				finalCol('b', 0, 16, 17, 0, 22, 23),
			]);
			expect(v).toHaveLength(0);
		});
	});

	// ── Tests: finalColumns fallback path ─────────────────────────────────────

	describe('finalColumns fallback path (no finalSelect)', () => {
		it('passes unique column names', () => {
			const columns: ColumnInfo[] = [
				{ name: 'order_id', line: 0, col: 7 },
				{ name: 'customer_id', line: 0, col: 17 },
			];
			const v = checkFinalColumns('select order_id, customer_id from t', columns);
			expect(v).toHaveLength(0);
		});

		it('flags duplicate column name', () => {
			const columns: ColumnInfo[] = [
				{ name: 'id', line: 0, col: 7 },
				{ name: 'id', line: 0, col: 10 },
			];
			const v = checkFinalColumns('select id, id from t', columns);
			expect(v).toHaveLength(1);
			expect(v[0].rule).toBe(RULE);
			expect(v[0].message).toContain('\'id\'');
		});

		it('comparison is case-insensitive in fallback path', () => {
			const columns: ColumnInfo[] = [
				{ name: 'id', line: 0, col: 7 },
				{ name: 'ID', line: 0, col: 10 },
			];
			const v = checkFinalColumns('select id, ID from t', columns);
			expect(v).toHaveLength(1);
		});

		it('passes empty finalColumns', () => {
			const v = checkFinalColumns('select 1', []);
			expect(v).toHaveLength(0);
		});
	});
});
