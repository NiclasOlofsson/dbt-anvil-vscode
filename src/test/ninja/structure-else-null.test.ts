import { describe, expect, it } from 'vitest';
import { model, sqlTok, run, violationsFor } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.structure.else-null';

function check(sql: string, tokens: SqlToken[]): NinjaViolation[] {
	const m = model({ sqlTokens: tokens });
	const result = run(sql, {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags ELSE NULL before END', () => {
		//             0         1         2         3         4         5
		//             012345678901234567890123456789012345678901234567890123456
		const sql = 'select case when a = 1 then 1 else null end from t';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('THEN', 23, 26, 0, 27),
			sqlTok('NUMBER', 28, 28, 0, 29),
			sqlTok('ELSE', 30, 33, 0, 34),
			sqlTok('NULL', 35, 38, 0, 39),
			sqlTok('END', 40, 42, 0, 43),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('Redundant');
		expect(v[0].action).toBeDefined();
	});

	it('no violation for ELSE <value> END', () => {
		const sql = 'select case when a = 1 then 1 else 0 end from t';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('THEN', 23, 26, 0, 27),
			sqlTok('NUMBER', 28, 28, 0, 29),
			sqlTok('ELSE', 30, 33, 0, 34),
			sqlTok('NUMBER', 35, 35, 0, 36),
			sqlTok('END', 37, 39, 0, 40),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for no ELSE', () => {
		const sql = 'select case when a = 1 then 1 end from t';
		const tokens: SqlToken[] = [
			sqlTok('CASE', 7, 10, 0, 11),
			sqlTok('WHEN', 12, 15, 0, 16),
			sqlTok('THEN', 23, 26, 0, 27),
			sqlTok('NUMBER', 28, 28, 0, 29),
			sqlTok('END', 30, 32, 0, 33),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});
});
