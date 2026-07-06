import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { implicitJoinRule } from '../../ninja/rules/ambiguity-implicit-join';
import type { SqlToken } from '../../ftl/sql-tokens';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.ambiguity.implicit-join';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return implicitJoinRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags bare JOIN', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890123456789
		const sql = 'select * from a join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('JOIN', 16, 19, 0, 20),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('INNER JOIN');
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'INNER join' });
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

	it('no violation for FULL JOIN', () => {
		const sql = 'select * from a full join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('FULL', 16, 19, 0, 20),
			sqlTok('JOIN', 21, 24, 0, 25),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for NATURAL JOIN', () => {
		const sql = 'select * from a natural join b';
		const tokens: SqlToken[] = [
			sqlTok('NATURAL', 16, 22, 0, 23),
			sqlTok('JOIN', 24, 27, 0, 28),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for LEFT OUTER JOIN (long form — the token before JOIN is OUTER)', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890123456789
		const sql = 'select * from a left outer join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('LEFT', 16, 19, 0, 20),
			sqlTok('OUTER', 21, 25, 0, 26),
			sqlTok('JOIN', 27, 30, 0, 31),
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

	it('no violation for LEFT SEMI JOIN (databricks)', () => {
		const sql = 'select * from a left semi join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('LEFT', 16, 19, 0, 20),
			sqlTok('SEMI', 21, 24, 0, 25),
			sqlTok('JOIN', 26, 29, 0, 30),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for LEFT ANTI JOIN (databricks)', () => {
		const sql = 'select * from a left anti join b on a.id = b.id';
		const tokens: SqlToken[] = [
			sqlTok('LEFT', 16, 19, 0, 20),
			sqlTok('ANTI', 21, 24, 0, 25),
			sqlTok('JOIN', 26, 29, 0, 30),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags multiple bare JOINs', () => {
		//             0         1         2         3         4
		//             01234567890123456789012345678901234567890123456789
		const sql = 'select * from a join b on 1=1 join c on 1=1';
		const tokens: SqlToken[] = [
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('JOIN', 16, 19, 0, 20),
			sqlTok('JOIN', 30, 33, 0, 34),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(implicitJoinRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});

// Live-parser regression for the gold__vendor F5 finding: the rule consumed a
// real token stream where LEFT OUTER JOIN precedes a templated relation, and
// fired on the OUTER long form. The engine's Join IR was correct throughout —
// the gap was this rule's qualifier set.
import { SqllensDocumentParser } from '../../ftl/sqllens/document-parser';

describe(`${RULE} — live parse, templated left outer join`, () => {
	it('does not fire on left outer join {{ ref() }} even with a broken trailing tag', async () => {
		const sql = [
			'select ve.vendorkey',
			'from {{ ref(\'gold__vendor\') }} ve',
			'left outer join {{ ref(\'gold__chain\') }} ca',
			"    on (ve.chainkey = ca.chainkey and ca.gold_sourcesystemkey='d365')",
			'left outer join {{ ref(\'gold__project\') }} pr',
			'    on (ve.projectkey = pr.projectkey)',
			"{{ generic_is_deleted('ve.is_deleted','where') }}",
		].join('\n');
		const parsed = await new SqllensDocumentParser({ adapterType: 'databricks' }).parse(sql);
		const doc = mockDocument(sql);
		const v = implicitJoinRule.check({ model: parsed, document: doc, config: cfg() });
		expect(v).toHaveLength(0);
	});
});
