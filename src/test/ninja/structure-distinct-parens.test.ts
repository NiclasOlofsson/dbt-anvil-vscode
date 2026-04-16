import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { distinctParensRule } from '../../ninja/rules/structure-distinct-parens';
import type { SqlToken } from '../../ftl/parse-result';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.structure.distinct-parens';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return distinctParensRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('flags DISTINCT(col)', () => {
		//             0123456789012345678901234
		const sql = 'select distinct(id) from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
			sqlTok('L_PAREN', 15, 15, 0, 16),
			sqlTok('VAR', 16, 17, 0, 18),
			sqlTok('R_PAREN', 18, 18, 0, 19),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('not a function');
		expect(v[0].action).toBeDefined();
		// Fix should remove ( and ) replacing ( with space
		expect((v[0].action as FixAction).edits[0].newText).toBe('');   // R_PAREN removal
		expect((v[0].action as FixAction).edits[1].newText).toBe(' ');   // L_PAREN to space
	});

	it('no violation for DISTINCT col (no parens)', () => {
		const sql = 'select distinct id from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
			sqlTok('VAR', 16, 17, 0, 18),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('does not flag DISTINCT with comma inside parens', () => {
		// DISTINCT(a, b) is weird but multi-column — skip
		const sql = 'select distinct(a, b) from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('DISTINCT', 7, 14, 0, 15),
			sqlTok('L_PAREN', 15, 15, 0, 16),
			sqlTok('VAR', 16, 16, 0, 17),
			sqlTok('COMMA', 17, 17, 0, 18),
			sqlTok('VAR', 19, 19, 0, 20),
			sqlTok('R_PAREN', 20, 20, 0, 21),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(distinctParensRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
