import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { unionStyleRule } from '../../ninja/rules/convention-union-style';
import { DEFAULT_CONFIG } from '../../ninja/config';
import type { SqlToken } from '../../ftl/parse-result';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.convention.union-style';

function check(sql: string, tokens: SqlToken[], unionStyle: 'all' | 'distinct' = 'all') {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return unionStyleRule.check({
		model: m, document: doc,
		config: cfg({ convention: { ...DEFAULT_CONFIG.convention, unionStyle } }),
	});
}

describe(RULE, () => {
	it('flags UNION DISTINCT when style is all (default)', () => {
		// 'select 1 union distinct select 2'
		//  0123456789...  9-13 UNION  15-22 DISTINCT
		const sql = 'select 1 union distinct select 2';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('DISTINCT', 15, 22, 0, 23),
			sqlTok('SELECT', 24, 29, 0, 30),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('UNION ALL');
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).edits[0].newText).toBe('ALL');
	});

	it('flags UNION ALL when style is distinct', () => {
		// 'select 1 union all select 2'
		//  9-13 UNION  15-17 ALL
		const sql = 'select 1 union all select 2';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('ALL', 15, 17, 0, 18),
			sqlTok('SELECT', 19, 24, 0, 25),
		];
		const v = check(sql, tokens, 'distinct');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('UNION DISTINCT');
		expect((v[0].action as FixAction).edits[0].newText).toBe('DISTINCT');
	});

	it('no violation when style matches (all)', () => {
		const sql = 'select 1 union all select 2';
		const tokens: SqlToken[] = [
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('ALL', 15, 17, 0, 18),
		];
		expect(check(sql, tokens, 'all')).toHaveLength(0);
	});

	it('ignores bare UNION — handled by ambiguity.bare-union', () => {
		const sql = 'select 1 union select 2';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('SELECT', 15, 20, 0, 21),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags multiple wrong-style UNIONs', () => {
		// 'select 1 union distinct select 2 union distinct select 3'
		//  0-5 SELECT  9-13 UNION  15-22 DISTINCT  24-29 SELECT  33-37 UNION  39-46 DISTINCT  48-53 SELECT
		const sql = 'select 1 union distinct select 2 union distinct select 3';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('UNION', 9, 13, 0, 14),
			sqlTok('DISTINCT', 15, 22, 0, 23),
			sqlTok('SELECT', 24, 29, 0, 30),
			sqlTok('UNION', 33, 37, 0, 38),
			sqlTok('DISTINCT', 39, 46, 0, 47),
			sqlTok('SELECT', 48, 53, 0, 54),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(unionStyleRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
