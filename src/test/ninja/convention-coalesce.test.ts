import { describe, expect, it } from 'vitest';
import { model, sqlTok, run, violationsFor, mockDocument } from './helpers';
import type { NinjaViolation } from '../../ninja/violation';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/sql-tokens';

const RULE = 'ninja.convention.coalesce';

function check(sql: string, tokens: SqlToken[]): NinjaViolation[] {
	const m = model({ sqlTokens: tokens });
	const result = run(sql, {}, m);
	return violationsFor(result, RULE);
}

describe(RULE, () => {
	it('flags IFNULL', () => {
		//             0         1
		//             0123456789012345678
		const sql = 'select ifnull(a, 0)';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 12, 0, 13),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('IFNULL');
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'coalesce' });
	});

	it('flags NVL', () => {
		//             0         1
		//             01234567890123
		const sql = 'select nvl(a, 0)';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 9, 0, 10),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('NVL');
	});

	it('flags ISNULL', () => {
		//             0         1
		//             012345678901234567
		const sql = 'select isnull(a, 0)';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 12, 0, 13),
		];
		expect(check(sql, tokens)).toHaveLength(1);
	});

	it('ignores COALESCE', () => {
		const sql = 'select coalesce(a, 0)';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 14, 0, 15),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('ignores unrelated VAR', () => {
		const sql = 'select my_col';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 12, 0, 13),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});
});
