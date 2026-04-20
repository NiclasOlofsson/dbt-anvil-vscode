import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { quotingPolicyRule } from '../../ninja/rules/reference-quoting-policy';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.reference.quoting-policy';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return quotingPolicyRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation when all identifiers are unquoted', () => {
		//             0         1
		//             0123456789012345678
		const sql = 'select id from t';
		const tokens: SqlToken[] = [
			sqlTok('VAR', 7, 8, 0, 9),    // id
			sqlTok('FROM', 10, 13, 0, 14),
			sqlTok('VAR', 15, 15, 0, 16), // t
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags unnecessarily quoted identifier when majority are unquoted', () => {
		//             0         1         2         3
		//             01234567890123456789012345678901
		const sql = 'select "id", name from t';
		const tokens: SqlToken[] = [
			sqlTok('QUOTED_IDENTIFIER', 7, 10, 0, 11),  // "id" — unnecessary
			sqlTok('VAR', 13, 16, 0, 17),                // name — unquoted
			sqlTok('FROM', 18, 21, 0, 22),
			sqlTok('VAR', 23, 23, 0, 24),                // t — unquoted
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('id');
		expect(v[0].message).toContain('without quotes');
		expect(v[0].range.start.character).toBe(7);
	});

	it('no violation when quoted identifier contains special characters (genuinely needs quotes)', () => {
		//             0         1         2         3
		//             01234567890123456789012345678901
		const sql = 'select "my col", name from t';
		const tokens: SqlToken[] = [
			sqlTok('QUOTED_IDENTIFIER', 7, 15, 0, 16), // "my col" — has space, needs quotes
			sqlTok('VAR', 18, 21, 0, 22),               // name
			sqlTok('FROM', 23, 26, 0, 27),
			sqlTok('VAR', 28, 28, 0, 29),               // t
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('no violation when all identifiers are quoted (consistent quoting policy)', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890
		const sql = 'select "id" from "t"';
		const tokens: SqlToken[] = [
			sqlTok('QUOTED_IDENTIFIER', 7, 10, 0, 11), // "id"
			sqlTok('FROM', 12, 15, 0, 16),
			sqlTok('QUOTED_IDENTIFIER', 17, 19, 0, 20), // "t"
		];
		// No unquoted identifiers — skip (can't establish a majority)
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags backtick-quoted plain identifier', () => {
		//             0         1         2
		//             0123456789012345678901234
		const sql = 'select `id`, name from t';
		const tokens: SqlToken[] = [
			sqlTok('BACKTICK', 7, 10, 0, 11),  // `id` — unnecessary
			sqlTok('VAR', 13, 16, 0, 17),       // name
			sqlTok('FROM', 18, 21, 0, 22),
			sqlTok('VAR', 23, 23, 0, 24),       // t
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('id');
	});

	it('no violation when quoted identifiers are majority', () => {
		// When quoted >= unquoted, the policy is "quote everything" — skip.
		const sql = 'select "id", "name", x from t';
		const tokens: SqlToken[] = [
			sqlTok('QUOTED_IDENTIFIER', 7, 10, 0, 11),  // "id"
			sqlTok('QUOTED_IDENTIFIER', 13, 18, 0, 19), // "name"
			sqlTok('VAR', 21, 21, 0, 22),               // x — only 1 unquoted
			sqlTok('FROM', 23, 26, 0, 27),
			sqlTok('VAR', 28, 28, 0, 29),               // t — 2 unquoted total
		];
		// 2 quoted >= 2 unquoted — don't flag
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags multiple unnecessarily quoted identifiers', () => {
		const sql = 'select "id", "name", status from t';
		const tokens: SqlToken[] = [
			sqlTok('QUOTED_IDENTIFIER', 7, 10, 0, 11),  // "id"
			sqlTok('QUOTED_IDENTIFIER', 13, 18, 0, 19), // "name"
			sqlTok('VAR', 21, 26, 0, 27),               // status
			sqlTok('FROM', 28, 31, 0, 32),
			sqlTok('VAR', 33, 33, 0, 34),               // t
			sqlTok('VAR', 35, 39, 0, 40),               // extra — to make unquoted majority
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(2);
		expect(v.every(x => x.rule === RULE)).toBe(true);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select "id" from t');
		const m = model({});
		expect(quotingPolicyRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
