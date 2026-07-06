import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { explicitInnerJoinRule } from '../../ninja/rules/convention-explicit-inner-join';
import type { SqlToken } from '../../ftl/sql-tokens';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.convention.explicit-inner-join';

function check(sql: string, tokens: SqlToken[], configOverrides = {}) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return explicitInnerJoinRule.check({ model: m, document: doc, config: cfg({ convention: { ...cfg().convention, ...configOverrides } }) });
}

describe(RULE, () => {
	it('flags bare JOIN', () => {
		const sql = 'select * from a join b on a.id = b.id';
		// FROM token then JOIN token
		const tokens: SqlToken[] = [
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('JOIN', 16, 19, 0, 20),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('INNER JOIN');
	});

	it('autofix replaces bare JOIN with INNER JOIN', () => {
		const sql = 'select * from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('JOIN', 16, 19, 0, 20),
		];
		const v = check(sql, tokens);
		expect(v[0].action?.type).toBe(FixAction.TYPE);
		const fixed = applyEditsToText(sql, (v[0].action as FixAction).ops);
		expect(fixed).toBe('select * from a INNER JOIN b on a.id = b.id');
	});

	it('no violation for INNER JOIN', () => {
		const sql = 'select * from a inner join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('INNER', 16, 20, 0, 21),
			sqlTok('JOIN', 22, 25, 0, 26),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for LEFT JOIN', () => {
		const sql = 'select * from a left join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('LEFT', 16, 19, 0, 20),
			sqlTok('JOIN', 21, 24, 0, 25),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for RIGHT JOIN', () => {
		const sql = 'select * from a right join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('RIGHT', 16, 20, 0, 21),
			sqlTok('JOIN', 22, 25, 0, 26),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for CROSS JOIN', () => {
		const sql = 'select * from a cross join b';
		const tokens: SqlToken[] = [
			sqlTok('CROSS', 16, 20, 0, 21),
			sqlTok('JOIN', 22, 25, 0, 26),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for FULL OUTER JOIN', () => {
		const sql = 'select * from a full outer join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('FULL', 16, 19, 0, 20),
			sqlTok('OUTER', 21, 25, 0, 26),
			sqlTok('JOIN', 27, 30, 0, 31),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('disabled when explicitInnerJoin is false', () => {
		const sql = 'select * from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('JOIN', 16, 19, 0, 20),
		];
		const doc = mockDocument(sql);
		const m = model({ sqlTokens: tokens });
		const c = cfg({ convention: { ...cfg().convention, explicitInnerJoin: false } });
		expect(explicitInnerJoinRule.check({ model: m, document: doc, config: c })).toHaveLength(0);
	});

	it('no violations without ninjaSqlTokens', () => {
		const doc = mockDocument('select * from a join b on a.id = b.id');
		const m = model({});
		expect(explicitInnerJoinRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
