import { describe, it, expect } from 'vitest';
import { run, violationsFor, capCfg, emptyModel, model, sym } from './helpers';
import { FixAction } from '../../ninja/violation';

const RULE = 'ninja.cap.functions';

describe(RULE, () => {
	// ── Policy: lower ──────────────────────────────────────────────────────

	it('flags uppercase function when policy is lower', () => {
		const v = violationsFor(run('select COUNT(*) from t', capCfg('functions', 'lower')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].message).toContain('count');
	});

	it('passes lowercase function', () => {
		const v = violationsFor(run('select count(*) from t', capCfg('functions', 'lower')), RULE);
		expect(v.length).toBe(0);
	});

	it('flags multiple uppercase functions', () => {
		const v = violationsFor(run('select COUNT(*), SUM(x), AVG(y) from t', capCfg('functions', 'lower')), RULE);
		expect(v.length).toBe(3);
	});

	// ── Policy: upper ──────────────────────────────────────────────────────

	it('flags lowercase function when policy is upper', () => {
		const v = violationsFor(run('select count(*) from t', capCfg('functions', 'upper')), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'COUNT' });
	});

	it('passes uppercase function when policy is upper', () => {
		const v = violationsFor(run('select COUNT(*) from t', capCfg('functions', 'upper')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Policy: consistent ─────────────────────────────────────────────────

	it('flags inconsistent function casing', () => {
		const v = violationsFor(run('select count(*), COUNT(*) from t', capCfg('functions', 'consistent')), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'count' });
	});

	it('passes consistent function casing', () => {
		const v = violationsFor(run('select count(*), count(*) from t', capCfg('functions', 'consistent')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Parenthesis detection ──────────────────────────────────────────────

	it('ignores function-name word not followed by parenthesis', () => {
		const v = violationsFor(run('select count from t', capCfg('functions', 'upper')), RULE);
		expect(v.length).toBe(0);
	});

	it('detects function with space before paren', () => {
		const v = violationsFor(run('select COUNT (*) from t', capCfg('functions', 'lower')), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'count' });
	});

	it('does not flag function inside -- line comment when sqlTokens include comment span', () => {
		const sql = '-- COUNT(*)\nselect 1';
		const start = sql.indexOf('COUNT');
		const end = start + 'COUNT(*)'.length;
		const modelWithCommentSpan = model({
			sqlTokens: [{
				type: 'SELECT',
				start: sql.indexOf('select'),
				end: sql.indexOf('select') + 'select'.length - 1,
				line: 1,
				col: 'select'.length,
				comments: [{ start, end, text: '-- COUNT(*)' }],
			}],
		});
		const v = violationsFor(run(sql, capCfg('functions', 'lower'), modelWithCommentSpan), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag function inside /* */ block comment when sqlTokens include comment span', () => {
		const sql = 'select 1 /* COUNT(*) */';
		const start = sql.indexOf('COUNT');
		const end = start + 'COUNT(*)'.length;
		const modelWithCommentSpan = model({
			sqlTokens: [{
				type: 'SELECT',
				start: 0,
				end: 5,
				line: 0,
				col: 6,
				comments: [{ start, end, text: '/* COUNT(*) */' }],
			}],
		});
		const v = violationsFor(run(sql, capCfg('functions', 'lower'), modelWithCommentSpan), RULE);
		expect(v.length).toBe(0);
	});

	it('does not flag function name inside string literal when sqlTokens contain a STRING span', () => {
		const sql = 'select \'COUNT(*)\' as label from t';
		const stringStart = sql.indexOf('\'');
		const stringEnd = sql.lastIndexOf('\'');
		const modelWithString = model({
			sqlTokens: [{
				type: 'STRING',
				start: stringStart,
				end: stringEnd,
				line: 0,
				col: stringEnd + 1,
			}],
		});
		const v = violationsFor(run(sql, capCfg('functions', 'lower'), modelWithString), RULE);
		expect(v.length).toBe(0);
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('fix targets the function name only', () => {
		const v = violationsFor(run('select COUNT(*) from t', capCfg('functions', 'lower')), RULE);
		expect(v[0].range.start.character).toBe(7);
		expect(v[0].range.end.character).toBe(12);
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'count' });
	});

	// ── Identifier skipping ────────────────────────────────────────────────

	it('skips words at identifier symbol positions', () => {
		const model = {
			...emptyModel,
			symbols: [sym('column', 'count', 0, 7)],
		};
		const v = violationsFor(run('select count(*) from t', capCfg('functions', 'upper'), model), RULE);
		expect(v.length).toBe(0);
	});

	// ── Edge cases ─────────────────────────────────────────────────────────

	it('handles empty document', () => {
		const v = violationsFor(run(''), RULE);
		expect(v.length).toBe(0);
	});

	it('handles nested function calls', () => {
		const v = violationsFor(run('select COALESCE(COUNT(*), 0) from t', capCfg('functions', 'lower')), RULE);
		expect(v.length).toBe(2);
	});

	it('handles multi-word functions like date_trunc', () => {
		const v = violationsFor(run('select DATE_TRUNC(\'day\', created_at) from t', capCfg('functions', 'lower')), RULE);
		expect(v.length).toBe(1);
		expect((v[0].action as FixAction).ops[0]).toMatchObject({ text: 'date_trunc' });
	});
});
