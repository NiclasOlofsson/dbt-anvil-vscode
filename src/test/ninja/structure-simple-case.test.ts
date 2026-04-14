import { describe, expect, it } from 'vitest';
import { model, sqlTok, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.structure.simple-case';

function check(sql: string, tokens: SqlToken[]): NinjaViolation[] {
	const m = model({ sqlTokens: tokens });
	const result = run(sql, {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags CASE WHEN x THEN TRUE ELSE FALSE END', () => {
		//             0         1         2         3         4         5
		//             01234567890123456789012345678901234567890123456789012
		const sql = 'select case when a > 0 then true else false end';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18),
			sqlTok('GT', 19, 19, 0, 20),
			sqlTok('NUMBER', 21, 21, 0, 22),
			sqlTok('THEN', 23, 26, 0, 27),
			sqlTok('TRUE', 28, 31, 0, 32),
			sqlTok('ELSE', 33, 36, 0, 37),
			sqlTok('FALSE', 38, 42, 0, 43),
			sqlTok('END', 44, 46, 0, 47),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('Simplify');
	});

	it('flags inverse: THEN FALSE ELSE TRUE', () => {
		const sql = 'select case when a > 0 then false else true end';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18),
			sqlTok('GT', 19, 19, 0, 20),
			sqlTok('NUMBER', 21, 21, 0, 22),
			sqlTok('THEN', 23, 26, 0, 27),
			sqlTok('FALSE', 28, 32, 0, 33),
			sqlTok('ELSE', 34, 37, 0, 38),
			sqlTok('TRUE', 39, 42, 0, 43),
			sqlTok('END', 44, 46, 0, 47),
		];
		expect(check(sql, tokens)).toHaveLength(1);
	});

	it('flags THEN 1 ELSE 0', () => {
		//             0         1         2         3         4
		//             012345678901234567890123456789012345678901234
		const sql = 'select case when a > 0 then 1 else 0 end';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18),
			sqlTok('GT', 19, 19, 0, 20),
			sqlTok('NUMBER', 21, 21, 0, 22),
			sqlTok('THEN', 23, 26, 0, 27),
			sqlTok('NUMBER', 28, 28, 0, 29),
			sqlTok('ELSE', 30, 33, 0, 34),
			sqlTok('NUMBER', 35, 35, 0, 36),
			sqlTok('END', 37, 39, 0, 40),
		];
		expect(check(sql, tokens)).toHaveLength(1);
	});

	it('no violation for multiple WHEN branches', () => {
		const sql = 'case when a then true when b then false else null end';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 0, 3, 0, 4),
			sqlTok('WHEN', 5, 8, 0, 9),
			sqlTok('VAR', 10, 10, 0, 11),
			sqlTok('THEN', 12, 15, 0, 16),
			sqlTok('TRUE', 17, 20, 0, 21),
			sqlTok('WHEN', 22, 25, 0, 26),
			sqlTok('VAR', 27, 27, 0, 28),
			sqlTok('THEN', 29, 32, 0, 33),
			sqlTok('FALSE', 34, 38, 0, 39),
			sqlTok('ELSE', 40, 43, 0, 44),
			sqlTok('NULL', 45, 48, 0, 49),
			sqlTok('END', 50, 52, 0, 53),
		];
		// This has multiple WHEN branches → not a simple boolean case
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for THEN value ELSE value (not boolean)', () => {
		const sql = 'select case when a > 0 then 5 else 10 end';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('VAR', 17, 17, 0, 18),
			sqlTok('GT', 19, 19, 0, 20),
			sqlTok('NUMBER', 21, 21, 0, 22),
			sqlTok('THEN', 23, 26, 0, 27),
			sqlTok('NUMBER', 28, 28, 0, 29),
			sqlTok('ELSE', 30, 33, 0, 34),
			sqlTok('NUMBER', 35, 36, 0, 37),
			sqlTok('END', 38, 40, 0, 41),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});
});
