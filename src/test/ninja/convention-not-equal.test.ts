import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok } from './helpers';
import { notEqualRule } from '../../ninja/rules/convention-not-equal';
import type { SqlToken } from '../../ftl/parse-result';
import { FixAction } from '../../ninja/violation';
import { DEFAULT_CONFIG } from '../../ninja/config';

const RULE = 'ninja.convention.not-equal';

function check(sql: string, tokens: SqlToken[], notEqual: '!=' | '<>' = '!=') {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return notEqualRule.check({
		model: m, document: doc,
		config: cfg({ convention: { ...DEFAULT_CONFIG.convention, notEqual } }),
	});
}

describe(RULE, () => {
	it('no violation when using preferred != style', () => {
		//             0         1         2
		//             0123456789012345678901234567
		const sql = 'select * from t where a != b';
		const tokens: SqlToken[] = [sqlTok('NEQ', 24, 25, 0, 26)];
		expect(check(sql, tokens, '!=')).toHaveLength(0);
	});

	it('flags <> when != is preferred', () => {
		const sql = 'select * from t where a <> b';
		const tokens: SqlToken[] = [sqlTok('NEQ', 24, 25, 0, 26)];
		const v = check(sql, tokens, '!=');
		expect(v).toHaveLength(1);
		expect(v[0].message).toContain('!=');
		expect(v[0].action).toBeDefined();
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: '!=' });
	});

	it('flags != when <> is preferred', () => {
		const sql = 'select * from t where a != b';
		const tokens: SqlToken[] = [sqlTok('NEQ', 24, 25, 0, 26)];
		const v = check(sql, tokens, '<>');
		expect(v).toHaveLength(1);
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: '<>' });
	});

	it('no violation when using preferred <> style', () => {
		const sql = 'select * from t where a <> b';
		const tokens: SqlToken[] = [sqlTok('NEQ', 24, 25, 0, 26)];
		expect(check(sql, tokens, '<>')).toHaveLength(0);
	});

	it('flags multiple violations', () => {
		//             0         1         2         3
		//             0123456789012345678901234567890123456789
		const sql = 'select * from t where a <> b and c <> d';
		const tokens: SqlToken[] = [
			sqlTok('NEQ', 24, 25, 0, 26),
			sqlTok('NEQ', 35, 36, 0, 37),
		];
		expect(check(sql, tokens, '!=')).toHaveLength(2);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({});
		expect(notEqualRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('no violations with empty sqlTokens', () => {
		const doc = mockDocument('select 1');
		const m = model({ sqlTokens: [] });
		expect(notEqualRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});
});
