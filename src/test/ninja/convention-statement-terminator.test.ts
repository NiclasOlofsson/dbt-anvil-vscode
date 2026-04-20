import { describe, it, expect } from 'vitest';
import { mockDocument, cfg, model, sqlTok, applyEditsToText } from './helpers';
import { statementTerminatorRule } from '../../ninja/rules/convention-statement-terminator';
import { FixAction } from '../../ninja/violation';
import type { SqlToken } from '../../ftl/parse-result';

const RULE = 'ninja.convention.statement-terminator';

function check(sql: string, tokens: SqlToken[]) {
	const doc = mockDocument(sql);
	const m = model({ sqlTokens: tokens });
	return statementTerminatorRule.check({ model: m, document: doc, config: cfg() });
}

describe(RULE, () => {
	it('no violation when no semicolons', () => {
		const sql = 'select a from t';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
		];
		expect(check(sql, tokens)).toHaveLength(0);
	});

	it('flags a trailing semicolon', () => {
		//             0         1
		//             0123456789012345
		const sql = 'select a from t;';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('SEMICOLON', 15, 15, 0, 16),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		expect(v[0].rule).toBe(RULE);
		expect(v[0].message).toContain('Semicolons are not needed');
		expect(v[0].action).toBeDefined();
	});

	it('autofix removes the semicolon', () => {
		const sql = 'select a from t;';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('VAR', 7, 7, 0, 8),
			sqlTok('FROM', 9, 12, 0, 13),
			sqlTok('VAR', 14, 14, 0, 15),
			sqlTok('SEMICOLON', 15, 15, 0, 16),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
		const ops = (v[0].action as FixAction).ops;
		expect(ops[0].kind).toBe('delete');
		const fixed = applyEditsToText(sql, ops);
		expect(fixed).toBe('select a from t');
	});

	it('flags a semicolon between statements', () => {
		const sql = 'select 1;\nselect 2';
		// Semicolon after 'select 1'
		// offsets: 'select'=0-5 l0, '1'=7 l0, ';'=8 l0, newline, 'select'=10-15 l1 ...
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('SEMICOLON', 8, 8, 0, 9),
			sqlTok('SELECT', 10, 15, 1, 6),
			sqlTok('NUMBER', 17, 17, 1, 8),
		];
		const v = check(sql, tokens);
		expect(v).toHaveLength(1);
	});

	it('flags multiple semicolons', () => {
		const sql = 'select 1;\nselect 2;';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('SEMICOLON', 8, 8, 0, 9),
			sqlTok('SELECT', 10, 15, 1, 6),
			sqlTok('NUMBER', 17, 17, 1, 8),
			sqlTok('SEMICOLON', 18, 18, 1, 9),
		];
		expect(check(sql, tokens)).toHaveLength(2);
	});

	it('no violations without sqlTokens', () => {
		const doc = mockDocument('select a from t;');
		const m = model({});
		expect(statementTerminatorRule.check({ model: m, document: doc, config: cfg() })).toHaveLength(0);
	});

	it('fix action is marked autoFix true', () => {
		const sql = 'select 1;';
		const tokens: SqlToken[] = [
			sqlTok('SELECT', 0, 5, 0, 6),
			sqlTok('NUMBER', 7, 7, 0, 8),
			sqlTok('SEMICOLON', 8, 8, 0, 9),
		];
		const v = check(sql, tokens);
		expect((v[0].action as FixAction).autoFix).toBe(true);
	});
});
