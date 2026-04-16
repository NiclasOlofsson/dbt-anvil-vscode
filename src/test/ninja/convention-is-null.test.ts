import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { isNullRule } from '../../ninja/rules/convention-is-null';
import type { SqlToken } from '../../ftl/parse-result';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.convention.is-null';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return isNullRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags = NULL', () => {
		//             0123456789012345678901234
		const sql = 'select * from t where a = NULL';
		const tokens: SqlToken[] = [
			sqlTok('EQ', 24, 24, 0, 25),
			sqlTok('NULL', 26, 29, 0, 30),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('IS NULL');
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).edits[0].newText).toBe('IS NULL');
	});

	it('flags != NULL', () => {
		const sql = 'select * from t where a != NULL';
		const tokens: SqlToken[] = [
			sqlTok('NEQ', 24, 25, 0, 26),
			sqlTok('NULL', 27, 30, 0, 31),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('IS NOT NULL');
		expect((v[0].action as FixAction).edits[0].newText).toBe('IS NOT NULL');
	});

	it('flags <> NULL', () => {
		const sql = 'select * from t where a <> NULL';
		const tokens: SqlToken[] = [
			sqlTok('NEQ', 24, 25, 0, 26),
			sqlTok('NULL', 27, 30, 0, 31),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect((v[0].action as FixAction).edits[0].newText).toBe('IS NOT NULL');
	});

	it('no violation for IS NULL', () => {
		const sql = 'select * from t where a IS NULL';
		const tokens: SqlToken[] = [
			sqlTok('IS', 24, 25, 0, 26),
			sqlTok('NULL', 27, 30, 0, 31),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation for EQ followed by non-NULL', () => {
		const sql = 'select * from t where a = 1';
		const tokens: SqlToken[] = [
			sqlTok('EQ', 24, 24, 0, 25),
			sqlTok('NUMBER', 26, 26, 0, 27),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(isNullRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('flags multiple violations', () => {
		const sql = 'select * from t where a = NULL and b != NULL';
		const tokens: SqlToken[] = [
			sqlTok('EQ', 24, 24, 0, 25),
			sqlTok('NULL', 26, 29, 0, 30),
			sqlTok('NEQ', 35, 36, 0, 37),
			sqlTok('NULL', 38, 41, 0, 42),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});
});
