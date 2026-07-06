import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { qualifyMultiTableRule } from '../../ninja/rules/reference-qualify-multi-table';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.reference.qualify-multi-table';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return qualifyMultiTableRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation when there are no JOINs', () => {
		//             0         1
		//             0123456789012345678
		const sql = 'select id from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),    // id
			sqlTok('FROM', 10, 13, 0, 14),
			sqlTok('VAR', 15, 15, 0, 16), // t
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags unqualified VAR in SELECT when a JOIN is present', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890123456
		const sql = 'select id from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),     // id — unqualified
			sqlTok('FROM', 10, 13, 0, 14),
			sqlTok('VAR', 15, 15, 0, 16),  // a
			sqlTok('JOIN', 17, 20, 0, 21),
			sqlTok('VAR', 22, 22, 0, 23),  // b
			sqlTok('VAR', 27, 27, 0, 28),  // a (before dot)
			sqlTok('DOT', 28, 28, 0, 29),
			sqlTok('VAR', 29, 30, 0, 31),  // id (after dot — qualified)
			sqlTok('VAR', 34, 34, 0, 35),  // b (before dot)
			sqlTok('DOT', 35, 35, 0, 36),
			sqlTok('VAR', 36, 37, 0, 38),  // id (after dot — qualified)
		];
		const v = check(sql, tokens);
		// The unqualified 'id' at position 7 should be flagged.
		// 'a' and 'b' are table qualifiers (followed by DOT) — not flagged.
		// 'id' tokens after DOT are qualified — not flagged.
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('id');
		expect(v[0].range.start.character).toBe(7);
	});

	it('does not flag qualified column references (after DOT)', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890
		const sql = 'select a.id from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),    // a (before dot)
			sqlTok('DOT', 8, 8, 0, 9),
			sqlTok('VAR', 9, 10, 0, 11),  // id (after dot)
			sqlTok('FROM', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18), // a
			sqlTok('JOIN', 19, 22, 0, 23),
			sqlTok('VAR', 24, 24, 0, 25), // b
			sqlTok('VAR', 29, 29, 0, 30), // a (before dot)
			sqlTok('DOT', 30, 30, 0, 31),
			sqlTok('VAR', 31, 32, 0, 33), // id
			sqlTok('VAR', 36, 36, 0, 37), // b (before dot)
			sqlTok('DOT', 37, 37, 0, 38),
			sqlTok('VAR', 38, 39, 0, 40), // id
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag function calls (VAR followed by L_PAREN)', () => {
		//             0         1         2         3         4
		//             0123456789012345678901234567890123456789012345
		const sql = 'select count(a.id) from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 11, 0, 12),   // count
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('VAR', 13, 13, 0, 14),  // a (before dot)
			sqlTok('DOT', 14, 14, 0, 15),
			sqlTok('VAR', 15, 16, 0, 17),  // id
			sqlTok('R_PAREN', 17, 17, 0, 18),
			sqlTok('FROM', 19, 22, 0, 23),
			sqlTok('VAR', 24, 24, 0, 25),  // a
			sqlTok('JOIN', 26, 29, 0, 30),
			sqlTok('VAR', 31, 31, 0, 32),  // b
		];
		// 'count' is a function call (followed by L_PAREN) — should not be flagged
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag alias defined after AS', () => {
		//             0         1         2         3         4
		//             0123456789012345678901234567890123456789012
		const sql = 'select a.id as my_id from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),      // a (table qualifier)
			sqlTok('DOT', 8, 8, 0, 9),
			sqlTok('VAR', 9, 10, 0, 11),    // id
			sqlTok('AS', 12, 13, 0, 14),
			sqlTok('VAR', 15, 19, 0, 20),   // my_id (alias after AS)
			sqlTok('FROM', 21, 24, 0, 25),
			sqlTok('VAR', 26, 26, 0, 27),   // a
			sqlTok('JOIN', 28, 31, 0, 32),
			sqlTok('VAR', 33, 33, 0, 34),   // b
		];
		// 'my_id' after AS should not be flagged
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags multiple unqualified columns when JOINs are present', () => {
		//             0         1         2
		//             0123456789012345678901234
		const sql = 'select id, name from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 8, 0, 9),     // id — unqualified
			sqlTok('VAR', 11, 14, 0, 15),  // name — unqualified
			sqlTok('FROM', 16, 19, 0, 20),
			sqlTok('VAR', 21, 21, 0, 22),  // a
			sqlTok('JOIN', 23, 26, 0, 27),
			sqlTok('VAR', 28, 28, 0, 29),  // b
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
		expect(v.every(x => x.rule === RULE)).toBe(true);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select a.id from a join b on a.id = b.id');
		const m = model({});
		expect(qualifyMultiTableRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
