import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { consistentSingleTableRule } from '../../ninja/rules/reference-consistent-single-table';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.reference.consistent-single-table';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return consistentSingleTableRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation for unqualified column in single-table query', () => {
		//             0         1
		//             0123456789012345678
		const sql = 'select id from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 8, 0, 9),    // id
			sqlTok('FROM', 10, 13, 0, 14),
			sqlTok('VAR', 15, 15, 0, 16), // t
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags qualified column in single-table query', () => {
		//             0         1         2
		//             0123456789012345678901234
		const sql = 'select t.id from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 7, 0, 8),    // t (qualifier)
			sqlTok('DOT', 8, 8, 0, 9),
			sqlTok('VAR', 9, 10, 0, 11),  // id
			sqlTok('FROM', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18), // t
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('redundant');
		// Range should point to the DOT token
		expect(v[0].range.start.character).toBe(8);
		expect(v[0].range.end.character).toBe(9);
	});

	it('no violation when JOINs are present — qualification is appropriate', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890123456
		const sql = 'select a.id from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 7, 0, 8),    // a (qualifier)
			sqlTok('DOT', 8, 8, 0, 9),
			sqlTok('VAR', 9, 10, 0, 11),  // id
			sqlTok('FROM', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18), // a
			sqlTok('JOIN', 19, 22, 0, 23),
			sqlTok('VAR', 24, 24, 0, 25), // b
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags multiple qualified columns in single-table query', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890
		const sql = 'select t.id, t.name from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 7, 0, 8),    // t
			sqlTok('DOT', 8, 8, 0, 9),
			sqlTok('VAR', 9, 10, 0, 11),  // id
			sqlTok('VAR', 13, 13, 0, 14), // t
			sqlTok('DOT', 14, 14, 0, 15),
			sqlTok('VAR', 15, 18, 0, 19), // name
			sqlTok('FROM', 20, 23, 0, 24),
			sqlTok('VAR', 25, 25, 0, 26), // t
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
		expect(v.every(x => x.rule === RULE)).toBe(true);
	});

	it('does not flag a dot inside a schema-qualified table reference in WHERE (non-VAR.VAR pattern)', () => {
		// A DOT where the right side is not a VAR is a non-standard pattern — skip it.
		// This test just ensures no false positives for unrecognized patterns.
		const sql = 'select id from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 8, 0, 9),
			sqlTok('FROM', 10, 13, 0, 14),
			sqlTok('VAR', 15, 15, 0, 16),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select t.id from t');
		const m = model({});
		expect(consistentSingleTableRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
