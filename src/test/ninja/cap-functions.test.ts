import { describe, it, expect } from 'vitest';
import { run, violationsFor, capCfg, emptyModel } from './helpers';

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
		expect(v[0].fix![0].newText).toBe('COUNT');
	});

	it('passes uppercase function when policy is upper', () => {
		const v = violationsFor(run('select COUNT(*) from t', capCfg('functions', 'upper')), RULE);
		expect(v.length).toBe(0);
	});

	// ── Policy: consistent ─────────────────────────────────────────────────

	it('flags inconsistent function casing', () => {
		const v = violationsFor(run('select count(*), COUNT(*) from t', capCfg('functions', 'consistent')), RULE);
		expect(v.length).toBe(1);
		expect(v[0].fix![0].newText).toBe('count');
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
		expect(v[0].fix![0].newText).toBe('count');
	});

	// ── Fix generation ─────────────────────────────────────────────────────

	it('fix targets the function name only', () => {
		const v = violationsFor(run('select COUNT(*) from t', capCfg('functions', 'lower')), RULE);
		expect(v[0].range.start.character).toBe(7);
		expect(v[0].range.end.character).toBe(12);
		expect(v[0].fix![0].newText).toBe('count');
	});

	// ── Identifier skipping ────────────────────────────────────────────────

	it('skips words at identifier token positions', () => {
		const model = {
			...emptyModel,
			tokens: [{ type: 'column_ref' as const, name: 'count', line: 0, col: 7, endCol: 12 }],
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
		expect(v[0].fix![0].newText).toBe('date_trunc');
	});
});
