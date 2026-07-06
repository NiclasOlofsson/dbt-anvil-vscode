import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { bareUnionRule } from '../../ninja/rules/ambiguity-bare-union';
import { DEFAULT_CONFIG } from '../../ninja/config';
import type { SqlToken } from '../../ftl/sql-tokens';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.ambiguity.bare-union';

function check(sql: string, tokens: SqlToken[], unionStyle: 'all' | 'distinct' = 'all') {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return bareUnionRule.check({
		model: m, document: doc,
		config: cfg({ convention: { ...DEFAULT_CONFIG.convention, unionStyle } }),
	});
}

describe(RULE, () => {
	it('flags bare UNION', () => {
		const sql = 'select 1 union select 2';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('SELECT', 15, 20, 0, 21),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('UNION ALL');
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'union ALL' });
	});

	it('no violation for UNION ALL', () => {
		const sql = 'select 1 union all select 2';
		const tokens: SqlToken[] = [
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('ALL', 15, 17, 0, 18),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for UNION DISTINCT', () => {
		const sql = 'select 1 union distinct select 2';
		const tokens: SqlToken[] = [
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('DISTINCT', 15, 22, 0, 23),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('respects unionStyle=distinct config', () => {
		const sql = 'select 1 union select 2';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('SELECT', 15, 20, 0, 21),
		];
		const v = check(sql, tokens, 'distinct');
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'union DISTINCT' });
	});

	it('flags multiple bare UNIONs', () => {
		const sql = 'select 1 union select 2 union select 3';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('SELECT', 15, 20, 0, 21),
			sqlTok('UNION', 24, 28, 0, 29),
			sqlTok('SELECT', 30, 35, 0, 36),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(bareUnionRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
