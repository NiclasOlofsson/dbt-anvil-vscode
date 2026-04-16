import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { distinctGroupByRule } from '../../ninja/rules/ambiguity-distinct-groupby';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.ambiguity.distinct-groupby';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return distinctGroupByRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags DISTINCT with GROUP BY', () => {
		const sql = 'select distinct a from t group by a';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
			sqlTok('GROUP', 25, 29, 0, 30),
			sqlTok('BY', 31, 32, 0, 33),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('redundant');
		expect(v[0].action).toBeUndefined();
	});

	it('no violation for DISTINCT without GROUP BY', () => {
		const sql = 'select distinct a from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for GROUP BY without DISTINCT', () => {
		const sql = 'select a, count(*) from t group by a';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('GROUP', 27, 31, 0, 32),
			sqlTok('BY', 33, 34, 0, 35),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(distinctGroupByRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
