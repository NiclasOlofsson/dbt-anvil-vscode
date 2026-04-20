import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { countRowsRule } from '../../ninja/rules/convention-count-rows';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.convention.count-rows';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return countRowsRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags COUNT(1)', () => {
		//             0123456789012345678
		const sql = 'select count(1) from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 11, 0, 12),     // count
			sqlTok('L_PAREN', 12, 12, 0, 13), // (
			sqlTok('NUMBER', 13, 13, 0, 14),   // 1
			sqlTok('R_PAREN', 14, 14, 0, 15),  // )
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('COUNT(*)');
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0].text).toBe('*');
	});

	it('no violation for COUNT(*)', () => {
		const sql = 'select count(*) from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 11, 0, 12),
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('STAR', 13, 13, 0, 14),
			sqlTok('R_PAREN', 14, 14, 0, 15),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for COUNT(col)', () => {
		const sql = 'select count(id) from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 11, 0, 12),
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('VAR', 13, 14, 0, 15),
			sqlTok('R_PAREN', 15, 15, 0, 16),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for COUNT(2)', () => {
		const sql = 'select count(2) from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 11, 0, 12),
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('NUMBER', 13, 13, 0, 14),
			sqlTok('R_PAREN', 14, 14, 0, 15),
		];
		// "2" is not "1" so no violation
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(countRowsRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('flags multiple COUNT(1) in same query', () => {
		const sql = 'select count(1), count(1) from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 11, 0, 12),
			sqlTok('L_PAREN', 12, 12, 0, 13),
			sqlTok('NUMBER', 13, 13, 0, 14),
			sqlTok('R_PAREN', 14, 14, 0, 15),
			sqlTok('VAR', 17, 21, 0, 22),
			sqlTok('L_PAREN', 22, 22, 0, 23),
			sqlTok('NUMBER', 23, 23, 0, 24),
			sqlTok('R_PAREN', 24, 24, 0, 25),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});

	it('ignores non-count function with (1)', () => {
		const sql = 'select foo(1) from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 9, 0, 10),
			sqlTok('L_PAREN', 10, 10, 0, 11),
			sqlTok('NUMBER', 11, 11, 0, 12),
			sqlTok('R_PAREN', 12, 12, 0, 13),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});
});
